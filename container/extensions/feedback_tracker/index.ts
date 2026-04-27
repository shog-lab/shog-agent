/**
 * ShogAgent Feedback Handler Extension
 *
 * Intercepts user feedback (corrections, challenges, complaints, preferences)
 * before agent processing and writes follow-up tracking entries to wiki.
 *
 * Runs silently — agent is unaware of this processing.
 */

import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Feedback signal patterns */
const CORRECTION_PATTERNS = [
  /不对|不是这样|你说错了|应该是|之前说的不对|你搞错/i,
  /不对吧|不是吧|真的吗|你确定吗/i,
];

const COMPLAINT_PATTERNS = [
  /太差了|根本不行|完全错了|垃圾|烂/i,
];

const PREFERENCE_PATTERNS = [
  /我觉得应该|我更喜欢|不如改成|应该这样/i,
];

const SELF_ADMISSION_PATTERNS = [
  /抱歉.*错|我搞错了|我收回刚才说的/i,
];

function extractUserText(event: { prompt?: string; message?: string; text?: string; content?: string }): string {
  return event.prompt || event.message || event.text || event.content || "";
}

function detectFeedbackType(text: string): "correction" | "complaint" | "preference" | "self-admission" | null {
  if (CORRECTION_PATTERNS.some((p) => p.test(text))) return "correction";
  if (COMPLAINT_PATTERNS.some((p) => p.test(text))) return "complaint";
  if (PREFERENCE_PATTERNS.some((p) => p.test(text))) return "preference";
  if (SELF_ADMISSION_PATTERNS.some((p) => p.test(text))) return "self-admission";
  return null;
}

/** Atomic write: write to .tmp then rename */
function atomicWrite(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filepath);
}

function now(): string {
  return new Date().toISOString();
}

function dateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function getFollowUpDays(): number {
  try {
    const configPath = "/workspace/group/wiki-config.json";
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return config.feedback?.followUpDays ?? 7;
    }
  } catch {}
  return 7;
}

interface FeedbackEntry {
  userText: string;
  type: "correction" | "complaint" | "preference" | "self-admission";
  timestamp: string;
}

const recentFeedback: FeedbackEntry[] = [];
const FEEDBACK_COOLDOWN_MS = 60_000; // Don't write twice within 1 minute

export default function feedbackHandlerExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const userText = extractUserText(event);
    if (!userText || userText.trim().length === 0) return;

    const feedbackType = detectFeedbackType(userText);
    if (!feedbackType) return;

    // Cooldown: don't process if we just wrote one
    const nowMs = Date.now();
    if (recentFeedback.length > 0) {
      const last = recentFeedback[recentFeedback.length - 1];
      if (nowMs - new Date(last.timestamp).getTime() < FEEDBACK_COOLDOWN_MS) return;
    }

    recentFeedback.push({ userText, type: feedbackType, timestamp: new Date(nowMs).toISOString() });

    // Run async, don't block agent startup
    processFeedback(userText, feedbackType).catch((err) => {
      console.error("[feedback-handler] error:", err);
    });
  });
}

async function processFeedback(
  userText: string,
  feedbackType: "correction" | "complaint" | "preference" | "self-admission",
): Promise<void> {
  const wikiDir = "/workspace/group/wiki";

  // Ensure wiki dir exists
  if (!fs.existsSync(wikiDir)) {
    fs.mkdirSync(wikiDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const typeTag = feedbackType;
  const summary = userText.slice(0, 50).replace(/\n/g, " ").trim();

  // Determine wiki type
  const wikiType = feedbackType === "preference" ? "preference" : "fact";

  // Write feedback entry
  const feedbackFilename = `${ts}_feedback_${slugify(summary)}.md`;
  const feedbackPath = path.join(wikiDir, feedbackFilename);

  const followUpDays = getFollowUpDays();
  const followUpDate = new Date(Date.now() + followUpDays * 86400_000).toISOString().slice(0, 10);

  const frontmatter = [
    "---",
    `date: ${dateStr()}`,
    `type: ${wikiType}`,
    `tags: [feedback, ${typeTag}]`,
    `source: user-feedback`,
    `summary: ${summary}`,
    "---",
    "",
    `## 用户反馈`,
    "",
    `- **类型**: ${typeTag}`,
    `- **内容**: ${userText}`,
    "",
    `## 处理状态`,
    "",
    `- **检测时间**: ${new Date().toISOString()}`,
    `- **Follow-up 观察期**: ${followUpDays} 天，至 ${followUpDate}`,
  ].join("\n");

  atomicWrite(feedbackPath, frontmatter);

  // Write follow-up entry
  const followUpFilename = `${ts}_followup_${slugify(summary)}.md`;
  const followUpPath = path.join(wikiDir, followUpFilename);

  const followUpFrontmatter = [
    "---",
    `date: ${dateStr()}`,
    `type: note`,
    `tags: [follow-up, feedback-tracked]`,
    `source: observation`,
    `summary: 观察反馈 "【${typeTag}】${summary}" 是否在后续生效`,
    "---",
    "",
    "## 观察任务",
    "",
    `- **反馈类型**: ${typeTag}`,
    `- **反馈摘要**: ${summary}`,
    `- **原始内容**: ${userText.slice(0, 200)}`,
    `- **观察期**: ${followUpDays} 天（至 ${followUpDate}）`,
    `- **验证标准**: 后续 3 次相关交互中用户不再反馈同类问题`,
    "",
    "## 验证记录",
    "",
    "- [ ] 交互 1：",
    "- [ ] 交互 2：",
    "- [ ] 交互 3：",
    "",
    "## 结论",
    "",
    "- 有效 / 需继续观察 / 已复发",
  ].join("\n");

  atomicWrite(followUpPath, followUpFrontmatter);

  // Append to maintenance log
  const logPath = path.join(wikiDir, "_feedback-log.md");
  const logEntry = `- ${dateStr()} | 【${typeTag}】${summary} → ${followUpFilename}\n`;
  const existingLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "# Feedback Log\n\n";
  atomicWrite(logPath, existingLog + logEntry);

  console.log(`[feedback-handler] wrote: ${feedbackFilename} + ${followUpFilename}`);
}
