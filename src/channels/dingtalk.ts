/**
 * DingTalk Channel for ShogAgent
 * Uses Stream mode (WebSocket long connection, no public URL needed).
 */

import * as DingTalkStreamSdk from 'dingtalk-stream-sdk-nodejs';
import { Channel, ImageAttachment, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import { getChatMeta } from '../db.js';
import { logger } from '../logger.js';

interface RichTextItem {
  type?: string; // "picture" for images
  text?: string;
  downloadCode?: string;
  pictureDownloadCode?: string;
}

interface DingTalkRobotMessage {
  msgtype: string;
  text?: {
    content: string;
    isReplyMsg?: boolean;
    repliedMsg?: {
      content?: { text?: string };
      senderId?: string;
      msgType?: string;
    };
  };
  content?: {
    downloadCode?: string;
    pictureDownloadCode?: string;
    richText?: RichTextItem[];
  };
  conversationId: string;
  conversationType: string; // '1' = 单聊, '2' = 群聊
  senderId: string;
  senderNick: string;
  senderStaffId: string;
  chatbotUserId: string;
  msgId: string;
  sessionWebhook: string;
  createAt: number;
  robotCode: string;
}

const JID_PREFIX = 'dt:';

// Conversation metadata cached from incoming messages
interface ConversationMeta {
  isGroup: boolean;
  senderId: string; // senderStaffId, needed for DM replies via oToMessages API
  dingtalkId?: string; // senderId (encrypted), needed for group at
}

const { DWClient, TOPIC_ROBOT } = DingTalkStreamSdk as unknown as {
  DWClient: new (opts: {
    clientId: string;
    clientSecret: string;
    keepAlive?: boolean;
  }) => {
    debug: boolean;
    getConfig: () => Record<string, unknown>;
    registerCallbackListener: (
      topic: string,
      callback: (res: { data: string; headers: { messageId: string } }) => void,
    ) => void;
    connect: () => Promise<void>;
    send: (messageId: string, payload: unknown) => void;
    disconnect: () => void;
  };
  TOPIC_ROBOT: string;
};

export class DingTalkChannel implements Channel {
  name = 'dingtalk';
  handlesOwnTrigger = true; // DingTalk only forwards @mentioned messages
  private client: InstanceType<typeof DWClient>;
  private opts: ChannelOpts;
  private appKey: string;
  private appSecret: string;
  private connected = false;
  // Cache conversation type + senderId per JID for proactive messaging
  private conversationMeta = new Map<string, ConversationMeta>();

  constructor(appKey: string, appSecret: string, opts: ChannelOpts) {
    this.opts = opts;
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.client = new DWClient({
      clientId: appKey,
      clientSecret: appSecret,
      keepAlive: true,
    });
    this.client.debug = false;

    const originalGetEndpoint = (
      this.client as unknown as {
        getEndpoint?: () => Promise<unknown>;
      }
    ).getEndpoint;
    if (originalGetEndpoint) {
      (
        this.client as unknown as { getEndpoint: () => Promise<unknown> }
      ).getEndpoint = async () => {
        const originalConsoleLog = console.log;
        console.log = (...args: unknown[]) => {
          const first = args[0];
          if (
            typeof first === 'object' &&
            first !== null &&
            'clientSecret' in first
          ) {
            const sanitized = { ...(first as Record<string, unknown>) };
            sanitized.clientSecret = '[REDACTED]';
            originalConsoleLog(sanitized, ...args.slice(1));
            return;
          }
          if (first === 'res.data') {
            originalConsoleLog(first, '[REDACTED]');
            return;
          }
          originalConsoleLog(...args);
        };
        try {
          return await originalGetEndpoint.call(this.client);
        } finally {
          console.log = originalConsoleLog;
        }
      };
    }
  }

  /** Download an image from DingTalk using downloadCode, return base64 + mimeType */
  private async downloadImage(
    downloadCode: string,
  ): Promise<ImageAttachment | null> {
    try {
      let accessToken =
        (this.client.getConfig() as { access_token?: string }).access_token ??
        '';

      const doDownload = async (token: string) => {
        return fetch(
          'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
          {
            method: 'POST',
            headers: {
              'x-acs-dingtalk-access-token': token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ downloadCode, robotCode: this.appKey }),
          },
        );
      };

      let res = await doDownload(accessToken);
      if (res.status === 400) {
        const body = await res.text();
        if (body.includes('InvalidAuthentication')) {
          accessToken = await this.refreshAccessToken();
          res = await doDownload(accessToken);
        } else {
          logger.error({ body }, 'DingTalk: image download API failed');
          return null;
        }
      }
      if (!res.ok) {
        logger.error(
          { status: res.status },
          'DingTalk: image download API failed',
        );
        return null;
      }

      const { downloadUrl } = (await res.json()) as { downloadUrl?: string };
      if (!downloadUrl) {
        logger.error('DingTalk: no downloadUrl in response');
        return null;
      }

      // Download the actual image
      const imgRes = await fetch(downloadUrl);
      if (!imgRes.ok) {
        logger.error({ status: imgRes.status }, 'DingTalk: image fetch failed');
        return null;
      }

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const contentType = imgRes.headers.get('content-type') || 'image/png';
      const mimeType = contentType.split(';')[0].trim();

      logger.info(
        { size: buffer.length, mimeType },
        'DingTalk: image downloaded',
      );
      return { data: buffer.toString('base64'), mimeType };
    } catch (err) {
      logger.error({ err }, 'DingTalk: image download error');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
      try {
        const msg = JSON.parse(res.data) as DingTalkRobotMessage;
        logger.info(
          { msgtype: msg.msgtype, conversationId: msg.conversationId },
          'DingTalk: message received',
        );

        // Extract text and image downloadCodes from all supported message types
        let text = '';
        const downloadCodes: string[] = [];

        let replyContent: string | undefined;
        let replySender: string | undefined;

        if (msg.msgtype === 'text') {
          text = msg.text?.content?.trim() || '';
          // Extract quoted message context if this is a reply
          if (msg.text?.isReplyMsg && msg.text.repliedMsg?.content?.text) {
            replyContent = msg.text.repliedMsg.content.text;
            replySender = msg.text.repliedMsg.senderId || 'unknown';
          }
        } else if (msg.msgtype === 'picture') {
          if (msg.content?.downloadCode)
            downloadCodes.push(msg.content.downloadCode);
        } else if (msg.msgtype === 'richText' && msg.content?.richText) {
          const textParts: string[] = [];
          for (const item of msg.content.richText) {
            if (item.text) textParts.push(item.text);
            if (item.type === 'picture' && item.downloadCode)
              downloadCodes.push(item.downloadCode);
          }
          text = textParts.join('').trim();
        }

        if (!text && downloadCodes.length === 0) {
          logger.debug(
            { msgtype: msg.msgtype },
            'DingTalk: unsupported message type',
          );
          this.client.send(res.headers.messageId, { status: 'OK' });
          return;
        }

        const chatJid = `${JID_PREFIX}${msg.conversationId}`;
        const isGroup = msg.conversationType === '2';

        // Cache conversation metadata for proactive messaging
        // Use senderStaffId (not senderId) — DingTalk oToMessages API requires staffId
        this.conversationMeta.set(chatJid, {
          isGroup,
          senderId: msg.senderStaffId || msg.senderId,
          dingtalkId: msg.senderId,
        });

        // Report metadata (including staffId for DM reply support)
        this.opts.onChatMetadata(
          chatJid,
          new Date(msg.createAt).toISOString(),
          undefined,
          'dingtalk',
          isGroup,
          msg.senderStaffId || msg.senderId,
        );

        // Check if this group is registered
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          // Download images if present
          let images: ImageAttachment[] | undefined;
          if (downloadCodes.length > 0) {
            const results = await Promise.all(
              downloadCodes.map((code) => this.downloadImage(code)),
            );
            const valid = results.filter(
              (r): r is ImageAttachment => r !== null,
            );
            if (valid.length > 0) images = valid;
          }

          const newMsg: NewMessage = {
            id: msg.msgId,
            chat_jid: chatJid,
            sender: msg.senderId,
            sender_name: msg.senderNick,
            content: text || '[图片]',
            timestamp: new Date(msg.createAt).toISOString(),
            is_from_me: false,
            is_bot_message: false,
            images,
            ...(replyContent && {
              reply_to_message_content: replyContent,
              reply_to_sender_name: replySender,
            }),
          };

          this.opts.onMessage(chatJid, newMsg);
        }

        // Acknowledge to DingTalk server
        this.client.send(res.headers.messageId, { status: 'OK' });
      } catch (err) {
        logger.error({ err }, 'DingTalk: callback error');
        try {
          this.client.send(res.headers.messageId, { status: 'OK' });
        } catch {
          /* ignore */
        }
      }
    });

    await this.client.connect();
    this.connected = true;
    logger.info('DingTalk channel connected');
  }

  /** Fetch a fresh access_token from DingTalk OAuth endpoint */
  private async refreshAccessToken(): Promise<string> {
    const res = await fetch(
      `https://oapi.dingtalk.com/gettoken?appkey=${this.appKey}&appsecret=${this.appSecret}`,
    );
    if (!res.ok)
      throw new Error(`DingTalk token refresh failed: ${res.status}`);
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token)
      throw new Error('DingTalk token refresh: no access_token in response');
    // Update the SDK's internal config so subsequent calls also use the new token
    (this.client.getConfig() as { access_token?: string }).access_token =
      data.access_token;
    return data.access_token;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    let accessToken =
      (this.client.getConfig() as { access_token?: string }).access_token ?? '';
    const conversationId = jid.slice(JID_PREFIX.length);

    // Resolve conversation metadata: in-memory cache first, then SQLite
    let meta = this.conversationMeta.get(jid);
    if (!meta) {
      const dbChat = getChatMeta(jid);
      if (dbChat) {
        meta = {
          isGroup: dbChat.is_group === 1,
          senderId: dbChat.last_sender_id ?? '',
        };
      }
    }

    // Determine API endpoint and body based on conversation type
    let url: string;
    let payload: unknown;

    if (meta && !meta.isGroup) {
      // 单聊: use oToMessages API with userId
      url = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
      payload = {
        robotCode: this.appKey,
        userIds: [meta.senderId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      };
    } else {
      // 群聊 (or unknown — default to group API with conversationId)
      url = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
      // Note: sampleText does not support at/mention. DingTalk API limitation.
      payload = {
        robotCode: this.appKey,
        openConversationId: conversationId,
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      };
    }

    const doSend = async (token: string) => {
      return fetch(url, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    };

    let res = await doSend(accessToken);

    // Token expired — refresh and retry once
    if (res.status === 400) {
      const body = await res.text();
      if (body.includes('InvalidAuthentication')) {
        logger.info('DingTalk: access_token expired, refreshing');
        try {
          accessToken = await this.refreshAccessToken();
          res = await doSend(accessToken);
        } catch (err) {
          logger.error({ err }, 'DingTalk: token refresh failed');
          return;
        }
      } else {
        logger.error(
          { jid, status: res.status, body },
          'DingTalk: sendMessage failed',
        );
        return;
      }
    }

    if (!res.ok) {
      const respBody = await res.text();
      logger.error(
        { jid, status: res.status, body: respBody },
        'DingTalk: sendMessage failed',
      );
    }
  }

  async sendImage(
    jid: string,
    imageUrl: string,
    caption?: string,
  ): Promise<void> {
    let accessToken =
      (this.client.getConfig() as { access_token?: string }).access_token ?? '';
    const conversationId = jid.slice(JID_PREFIX.length);

    let meta = this.conversationMeta.get(jid);
    if (!meta) {
      const dbChat = getChatMeta(jid);
      if (dbChat) {
        meta = {
          isGroup: dbChat.is_group === 1,
          senderId: dbChat.last_sender_id ?? '',
        };
      }
    }

    let url: string;
    let payload: unknown;

    if (meta && !meta.isGroup) {
      url = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
      payload = {
        robotCode: this.appKey,
        userIds: [meta.senderId],
        msgKey: 'sampleImageMsg',
        msgParam: JSON.stringify({ photoURL: imageUrl }),
      };
    } else {
      url = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
      payload = {
        robotCode: this.appKey,
        openConversationId: conversationId,
        msgKey: 'sampleImageMsg',
        msgParam: JSON.stringify({ photoURL: imageUrl }),
      };
    }

    const doSend = async (token: string) => {
      return fetch(url, {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    };

    let res = await doSend(accessToken);

    if (res.status === 400) {
      const body = await res.text();
      if (body.includes('InvalidAuthentication')) {
        accessToken = await this.refreshAccessToken();
        res = await doSend(accessToken);
      } else {
        logger.error(
          { jid, status: res.status, body },
          'DingTalk: sendImage failed',
        );
        return;
      }
    }

    if (!res.ok) {
      const respBody = await res.text();
      logger.error(
        { jid, status: res.status, body: respBody },
        'DingTalk: sendImage failed',
      );
      return;
    }

    // Caption is intentionally not sent as a separate message —
    // the agent's final response already provides context.
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client.disconnect();
  }
}

// Self-register
registerChannel('dingtalk', (opts: ChannelOpts) => {
  const secrets = readEnvFile(['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET']);
  const appKey = secrets.DINGTALK_APP_KEY;
  const appSecret = secrets.DINGTALK_APP_SECRET;

  if (!appKey || !appSecret) {
    logger.warn(
      'DingTalk: DINGTALK_APP_KEY or DINGTALK_APP_SECRET not set — skipping',
    );
    return null;
  }

  return new DingTalkChannel(appKey, appSecret, opts);
});
