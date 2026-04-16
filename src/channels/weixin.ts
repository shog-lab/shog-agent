/**
 * WeChat Channel for ShogAgent
 * Uses iLink Bot API (official Tencent protocol) with HTTP long-polling.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Channel, ImageAttachment, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';
import { getChatMeta } from '../db.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const JID_PREFIX = 'wx:';
const AUTH_FILE = path.join(DATA_DIR, 'weixin-auth.json');
const CHANNEL_VERSION = '1.0.2';

interface WeixinAuth {
  botToken: string;
}

interface WeixinMessage {
  message_type: number;
  message_state: number;
  from_user_id: string;
  to_user_id: string;
  from_user_nickname?: string;
  context_token: string;
  item_list?: Array<{
    type?: number; // 1=text, 2=image, 3=audio, 4=file, 5=video
    text_item?: { text: string };
    voice_item?: {
      text?: string; // 语音转文字（微信服务端自动识别）
      playtime?: number; // 语音时长（毫秒）
    };
    image_item?: {
      url: string;
      aeskey: string;
      media?: {
        encrypt_query_param: string;
        aes_key: string; // base64(hex_string) → 16-byte key
      };
      mid_size?: number;
      hd_size?: number;
      thumb_size?: number;
      thumb_width?: number;
      thumb_height?: number;
    };
    [key: string]: unknown;
  }>;
}

export class WeixinChannel implements Channel {
  name = 'weixin';
  handlesOwnTrigger = false; // WeChat forwards all group messages, needs trigger
  private opts: ChannelOpts;
  private auth: WeixinAuth | null = null;
  private connected = false;
  private polling = false;
  private getUpdatesBuf = '';
  // Cache context_token per user for replies
  private contextTokens = new Map<string, string>();
  // Cache typing_ticket per user
  private typingTickets = new Map<
    string,
    { ticket: string; expires: number }
  >();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  /** Generate random UIN for anti-replay (random uint32 → decimal string → base64) */
  private static randomUin(): string {
    const uint32 = Math.floor(Math.random() * 0xffffffff);
    return Buffer.from(String(uint32)).toString('base64');
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': WeixinChannel.randomUin(),
    };
    if (this.auth?.botToken) {
      h['Authorization'] = `Bearer ${this.auth.botToken}`;
    }
    return h;
  }

  /** Load saved auth from disk */
  private loadAuth(): WeixinAuth | null {
    try {
      if (fs.existsSync(AUTH_FILE)) {
        return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** Save auth to disk */
  private saveAuth(auth: WeixinAuth): void {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
  }

  /** QR code login flow */
  private async login(): Promise<WeixinAuth> {
    logger.info('WeChat: starting QR code login...');

    // Step 1: Get QR code
    const qrRes = await fetch(
      `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
      {
        headers: this.headers,
      },
    );
    if (!qrRes.ok)
      throw new Error(`WeChat QR code request failed: ${qrRes.status}`);
    const qrData = (await qrRes.json()) as {
      qrcode?: string;
      qrcode_img_content?: string;
    };
    const qrcode = qrData.qrcode || '';
    const qrUrl = qrData.qrcode_img_content || '';

    logger.info(`WeChat: scan QR code to login: ${qrUrl}`);
    console.error(`\n[WeChat Login] Scan QR code: ${qrUrl}\n`);

    // Step 2: Poll for confirmation
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch(
        `${ILINK_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        { headers: this.headers },
      );
      if (!statusRes.ok) continue;
      const statusData = (await statusRes.json()) as {
        status?: string;
        bot_token?: string;
        baseurl?: string;
      };
      if (statusData.status === 'confirmed' && statusData.bot_token) {
        const auth: WeixinAuth = { botToken: statusData.bot_token };
        this.saveAuth(auth);
        logger.info('WeChat: login successful');
        return auth;
      }
      if (statusData.status === 'expired') {
        throw new Error('WeChat QR code expired, please restart');
      }
    }
  }

  /** Get typing ticket for a user (cached 24h) */
  private async getTypingTicket(contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(contextToken);
    if (cached && cached.expires > Date.now()) return cached.ticket;

    try {
      const res = await fetch(`${ILINK_BASE_URL}/ilink/bot/getconfig`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          context_token: contextToken,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { typing_ticket?: string };
      if (data.typing_ticket) {
        this.typingTickets.set(contextToken, {
          ticket: data.typing_ticket,
          expires: Date.now() + 24 * 60 * 60 * 1000,
        });
        return data.typing_ticket;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Parse AES key from base64. Two encodings exist:
   * - base64(raw 16 bytes) → direct key
   * - base64(32-char hex string) → hex decode to 16 bytes
   */
  private static parseAesKey(aesKeyBase64: string): Buffer {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16) return decoded;
    if (
      decoded.length === 32 &&
      /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))
    ) {
      return Buffer.from(decoded.toString('ascii'), 'hex');
    }
    throw new Error(`Unexpected aes_key length: ${decoded.length}`);
  }

  /** Download and decrypt an image from WeChat CDN */
  private async downloadImage(
    encryptQueryParam: string,
    aesKeyBase64: string,
  ): Promise<ImageAttachment | null> {
    try {
      const cdnUrl = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
      const res = await fetch(cdnUrl);
      if (!res.ok) {
        logger.error({ status: res.status }, 'WeChat: image download failed');
        return null;
      }

      const encrypted = Buffer.from(await res.arrayBuffer());
      const key = WeixinChannel.parseAesKey(aesKeyBase64);
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      // Detect MIME type from magic bytes
      let mimeType = 'image/jpeg';
      if (decrypted[0] === 0x89 && decrypted[1] === 0x50)
        mimeType = 'image/png';
      else if (decrypted[0] === 0x47 && decrypted[1] === 0x49)
        mimeType = 'image/gif';
      else if (decrypted[0] === 0x52 && decrypted[1] === 0x49)
        mimeType = 'image/webp';

      logger.info(
        { size: decrypted.length, mimeType },
        'WeChat: image downloaded and decrypted',
      );
      return { data: decrypted.toString('base64'), mimeType };
    } catch (err) {
      logger.error({ err }, 'WeChat: image download/decrypt error');
      return null;
    }
  }

  /** Long-polling message loop */
  private async pollMessages(): Promise<void> {
    this.polling = true;
    let retryDelay = 1000;

    while (this.polling) {
      try {
        const res = await fetch(`${ILINK_BASE_URL}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          }),
        });

        if (!res.ok) {
          if (res.status === 401) {
            logger.error('WeChat: token expired, need re-login');
            this.connected = false;
            this.polling = false;
            break;
          }
          throw new Error(`getupdates failed: ${res.status}`);
        }

        const data = (await res.json()) as {
          get_updates_buf?: string;
          msgs?: WeixinMessage[];
        };

        if (data.get_updates_buf) {
          this.getUpdatesBuf = data.get_updates_buf;
        }

        retryDelay = 1000; // Reset on success

        if (data.msgs?.length) {
          logger.info(
            {
              count: data.msgs.length,
              raw: JSON.stringify(data.msgs).slice(0, 500),
            },
            'WeChat: messages received',
          );
          for (const msg of data.msgs) {
            await this.handleMessage(msg);
          }
        }
      } catch (err) {
        logger.warn({ err, retryDelay }, 'WeChat: poll error, retrying');
        await new Promise((r) => setTimeout(r, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 30000); // Exponential backoff, max 30s
      }
    }
  }

  /** Process a single incoming message */
  private async handleMessage(msg: WeixinMessage): Promise<void> {
    // Extract text from item_list (text items + voice transcriptions)
    const text = msg.item_list
      ?.map((item) => {
        if (item.text_item?.text) return item.text_item.text;
        if (item.type === 3 && item.voice_item?.text)
          return item.voice_item.text;
        return '';
      })
      .filter(Boolean)
      .join('')
      .trim();

    // Extract image items (need media.encrypt_query_param + media.aes_key for download)
    const imageItems =
      msg.item_list?.filter(
        (item) =>
          item.type === 2 &&
          item.image_item?.media?.encrypt_query_param &&
          item.image_item?.media?.aes_key,
      ) || [];

    if (!text && imageItems.length === 0) return;

    const chatJid = `${JID_PREFIX}${msg.from_user_id}`;

    // Cache context_token for replies
    this.contextTokens.set(chatJid, msg.context_token);

    // Report metadata
    this.opts.onChatMetadata(
      chatJid,
      new Date().toISOString(),
      msg.from_user_nickname,
      'weixin',
    );

    // Check if this group is registered
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      // Download images in parallel
      let images: ImageAttachment[] | undefined;
      if (imageItems.length > 0) {
        const results = await Promise.all(
          imageItems.map((item) =>
            this.downloadImage(
              item.image_item!.media!.encrypt_query_param,
              item.image_item!.media!.aes_key,
            ),
          ),
        );
        const valid = results.filter((r): r is ImageAttachment => r !== null);
        if (valid.length > 0) images = valid;
      }

      const newMsg: NewMessage = {
        id: `wx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: chatJid,
        sender: msg.from_user_id,
        sender_name: msg.from_user_nickname || msg.from_user_id,
        content: text || '[图片]',
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
        images,
      };

      this.opts.onMessage(chatJid, newMsg);
    }
  }

  async connect(): Promise<void> {
    // Try to load saved auth
    this.auth = this.loadAuth();

    if (!this.auth) {
      // Need to login
      this.auth = await this.login();
    }

    this.connected = true;
    logger.info('WeChat channel connected');

    // Start polling in background
    this.pollMessages().catch((err) => {
      logger.error({ err }, 'WeChat: polling loop crashed');
      this.connected = false;
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const userId = jid.slice(JID_PREFIX.length);

    // Get context_token (from cache or DB)
    let contextToken = this.contextTokens.get(jid);
    if (!contextToken) {
      const dbChat = getChatMeta(jid);
      if (dbChat?.last_sender_id) {
        contextToken = dbChat.last_sender_id;
      }
    }
    if (!contextToken) {
      logger.error({ jid }, 'WeChat: no context_token for user, cannot send');
      return;
    }

    // Split long text into chunks (WeChat has message length limits)
    const maxLen = 2000;
    const chunks = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }

    for (const chunk of chunks) {
      const clientId = `shog-agent-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 6)}`;
      const res = await fetch(`${ILINK_BASE_URL}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          msg: {
            to_user_id: userId,
            context_token: contextToken,
            message_type: 2,
            message_state: 2,
            client_id: clientId,
            item_list: [{ type: 1, text_item: { text: chunk } }],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.error(
          { jid, status: res.status, body },
          'WeChat: sendMessage failed',
        );
      }
    }
  }

  async sendImage(
    jid: string,
    imageUrl: string,
    _caption?: string,
  ): Promise<void> {
    const userId = jid.slice(JID_PREFIX.length);

    let contextToken = this.contextTokens.get(jid);
    if (!contextToken) {
      const dbChat = getChatMeta(jid);
      if (dbChat?.last_sender_id) contextToken = dbChat.last_sender_id;
    }
    if (!contextToken) {
      logger.error({ jid }, 'WeChat: no context_token, cannot send image');
      return;
    }

    try {
      // 1. Download image
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        logger.error(
          { status: imgRes.status },
          'WeChat: image download failed for upload',
        );
        return;
      }
      const plaintext = Buffer.from(await imgRes.arrayBuffer());
      const rawfilemd5 = crypto
        .createHash('md5')
        .update(plaintext)
        .digest('hex');
      const aeskey = crypto.randomBytes(16);
      const filekey = crypto.randomBytes(16).toString('hex');
      // AES-128-ECB padded size
      const filesize = Math.ceil((plaintext.length + 1) / 16) * 16;

      // 2. Get upload URL
      const uploadRes = await fetch(
        `${ILINK_BASE_URL}/ilink/bot/getuploadurl`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            filekey,
            media_type: 1, // IMAGE
            to_user_id: userId,
            rawsize: plaintext.length,
            rawfilemd5,
            filesize,
            no_need_thumb: true,
            aeskey: aeskey.toString('hex'),
            base_info: { channel_version: CHANNEL_VERSION },
          }),
        },
      );
      if (!uploadRes.ok) {
        logger.error(
          { status: uploadRes.status },
          'WeChat: getuploadurl failed',
        );
        return;
      }
      const uploadData = (await uploadRes.json()) as { upload_param?: string };
      if (!uploadData.upload_param) {
        logger.error('WeChat: getuploadurl returned no upload_param');
        return;
      }

      // 3. Encrypt and upload to CDN
      const cipher = crypto.createCipheriv('aes-128-ecb', aeskey, null);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);

      const cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadData.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
      const cdnRes = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      if (!cdnRes.ok) {
        logger.error({ status: cdnRes.status }, 'WeChat: CDN upload failed');
        return;
      }
      const downloadParam = cdnRes.headers.get('x-encrypted-param');
      if (!downloadParam) {
        logger.error('WeChat: CDN response missing x-encrypted-param');
        return;
      }

      // 4. Send image message
      const clientId = `shog-agent-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 6)}`;
      const sendRes = await fetch(`${ILINK_BASE_URL}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          msg: {
            to_user_id: userId,
            context_token: contextToken,
            message_type: 2,
            message_state: 2,
            client_id: clientId,
            item_list: [
              {
                type: 2,
                image_item: {
                  media: {
                    encrypt_query_param: downloadParam,
                    aes_key: Buffer.from(aeskey.toString('hex')).toString(
                      'base64',
                    ),
                    encrypt_type: 1,
                  },
                  mid_size: ciphertext.length,
                },
              },
            ],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        }),
      });
      if (!sendRes.ok) {
        const body = await sendRes.text();
        logger.error(
          { status: sendRes.status, body },
          'WeChat: sendImage failed',
        );
      } else {
        logger.info({ jid, size: plaintext.length }, 'WeChat: image sent');
      }
    } catch (err) {
      logger.error({ err }, 'WeChat: sendImage error');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const contextToken = this.contextTokens.get(jid);
    if (!contextToken) return;

    const ticket = await this.getTypingTicket(contextToken);
    if (!ticket) return;

    try {
      await fetch(`${ILINK_BASE_URL}/ilink/bot/sendtyping`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          context_token: contextToken,
          typing_ticket: ticket,
          status: isTyping ? 1 : 2,
          base_info: { channel_version: CHANNEL_VERSION },
        }),
      });
    } catch {
      /* ignore typing errors */
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    this.connected = false;
  }
}

// Self-register
registerChannel('weixin', (opts: ChannelOpts) => {
  const env = readEnvFile(['WEIXIN_ENABLED']);

  // Only enable if explicitly set (QR login requires interaction)
  if (env.WEIXIN_ENABLED !== 'true' && !fs.existsSync(AUTH_FILE)) {
    logger.debug(
      'WeChat: not enabled (set WEIXIN_ENABLED=true in .env or login first)',
    );
    return null;
  }

  return new WeixinChannel(opts);
});
