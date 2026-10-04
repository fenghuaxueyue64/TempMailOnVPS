// src/notify/telegram.ts — Telegram Bot 通知（新邮件到达时推送）
import type { MailEvent } from "../events";

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  defaultChatId: string;
}

const API_BASE = "https://api.telegram.org";

/** 发送一条 Telegram 消息；失败仅打日志，不影响邮件主流程 */
export async function sendTelegram(cfg: TelegramConfig, chatId: string, text: string): Promise<void> {
  if (!cfg.botToken || !chatId) return;
  try {
    const res = await fetch(`${API_BASE}/bot${cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`telegram: send failed HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("telegram: send error", err);
  }
}

/** 格式化邮件事件为 Telegram 通知文本 */
function formatMail(e: MailEvent): string {
  const subj = e.subject || "(no subject)";
  return [
    "<b>✉ New mail</b>",
    `<b>To:</b> <code>${escapeHtml(e.address)}</code>`,
    `<b>From:</b> ${escapeHtml(e.from)}`,
    `<b>Subject:</b> ${escapeHtml(subj)}`,
    `<b>At:</b> ${e.receivedAt}`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

/** 新邮件到达 → 推送到默认 chat（如配置） */
export async function notifyMail(cfg: TelegramConfig, e: MailEvent): Promise<void> {
  if (!cfg.enabled || !cfg.defaultChatId) return;
  await sendTelegram(cfg, cfg.defaultChatId, formatMail(e));
}
