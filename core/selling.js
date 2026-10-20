/**
 * 销售引擎（内嵌版）—— 打包进 npm 包，随产品分发
 *
 * 三个职责：
 *   1. 许可验证   —— 判断是不是 Pro 用户
 *   2. 用量追踪   —— 免费版额度，到点提示升级
 *   3. 归因       —— 记录来源，付款时知道从哪来
 *
 * 设计原则：
 *   · 绝不阻断免费使用（除非真的超限）
 *   · 不联网也能工作（本地状态 + 离线验证）
 *   · 提示要克制（只在真的用到上限时出现）
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ============================================================
// 配置
// ============================================================
const CHANNELS = {
  n8n: "n8n-node",
  cli: "pypi-cli",
  mcp: "mcp-server",
  extension: "chrome-ext",
};

// Dodo 产品 ID
const CHECKOUT_BASE = "https://checkout.dodopayments.com/buy";

const PLANS = {
  pro: {
    id: "pdt_0Nq62Ecr9PnrPukjAEhaM",
    price: "$49",
    label: "Pro",
  },
  report: {
    id: "pdt_0Nq63a5zRdQV94lR1uRQo",
    price: "$39",
    label: "Report",
  },
};

const FREE_LIMITS = {
  runsPerDay: 100,
  maxRows: 10000,
};

const PRO_LIMITS = {
  runsPerDay: -1,
  maxRows: 5000000,
};

function checkoutUrl(channel, plan) {
  const p = PLANS[plan] || PLANS.pro;
  const ref = CHANNELS[channel] || channel;
  return `${CHECKOUT_BASE}/${p.id}?ref=${ref}`;
}

// ============================================================
// 状态存储
// ============================================================
function stateDir() {
  // 候选目录：环境变量 > 用户目录 > 临时目录
  const candidates = [
    process.env.DATACHECK_STATE_DIR,
    path.join(os.homedir(), ".datacheck"),
    path.join(os.tmpdir(), "datacheck-state"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, ".w");
      fs.writeFileSync(probe, "1");
      fs.unlinkSync(probe);
      return dir;
    } catch {
      continue;
    }
  }
  return "";
}

function loadState() {
  const dir = stateDir();
  if (!dir) return {};
  const p = path.join(dir, "state.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* ignore */
  }
  return {};
}

function saveState(state) {
  const dir = stateDir();
  if (!dir) return;
  try {
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify(state, null, 2)
    );
  } catch {
    /* ignore */
  }
}

// ============================================================
// 许可验证
// ============================================================
const SIG_LEN = 16;
const DEFAULT_SECRET = "dvq-public-verify-2026";

/**
 * 验证 license key
 * 格式: DVC-{plan}-{email_b64}-{expires}-{sig}
 */
function verifyLicense(key) {
  if (!key || typeof key !== "string") {
    return { valid: false, plan: "free", reason: "no key" };
  }
  key = key.trim();
  if (!key.startsWith("DVC-")) {
    return { valid: false, plan: "free", reason: "not a license key" };
  }

  // 从右切分（email_b64 可能含 -）
  const rest = key.slice(4); // 去掉 "DVC-"
  const parts = rest.split("-");
  if (parts.length < 4) {
    return { valid: false, plan: "free", reason: "malformed key" };
  }
  const sig = parts.pop();
  const expires = parts.pop();
  const plan = parts.shift();
  const emailB64 = parts.join("-");

  // 验签
  const secret = process.env.DATACHECK_LICENSE_SECRET || DEFAULT_SECRET;
  const payload = `${plan}.${emailB64}.${expires}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, SIG_LEN);

  if (expected !== sig) {
    return { valid: false, plan: "free", reason: "invalid signature" };
  }

  // 检查过期
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(expires);
  if (!m) {
    return { valid: false, plan: "free", reason: "bad expiry" };
  }
  const expDate = new Date(
    Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10))
  );
  if (expDate < new Date()) {
    return { valid: false, plan, reason: "expired" };
  }

  let email = "";
  try {
    email = Buffer.from(emailB64, "base64").toString("utf8");
  } catch {
    /* ignore */
  }

  return {
    valid: true,
    plan,
    email,
    expires,
    seats: plan === "team" ? 5 : 1,
  };
}

/**
 * 从 n8n 凭据或环境变量读取许可
 */
function resolveLicense(credentials) {
  const key =
    (credentials && credentials.licenseKey) ||
    process.env.DATACHECK_LICENSE ||
    (() => {
      const s = loadState();
      return s.license || "";
    })();

  if (!key) return { valid: false, plan: "free", reason: "no license" };
  return verifyLicense(key);
}

// ============================================================
// 用量追踪
// ============================================================
function checkUsage(license, channel, rows, options = {}) {
  const limits =
    license && license.valid && ["pro", "team"].includes(license.plan)
      ? PRO_LIMITS
      : FREE_LIMITS;

  // 行数限制
  if (rows > limits.maxRows) {
    return {
      allowed: false,
      reason: "row_limit",
      runsToday: 0,
      limit: limits.maxRows,
      shouldUpsell: true,
      upsellMessage:
        `This run has ${rows.toLocaleString()} rows. ` +
        `The free tier handles up to ${limits.maxRows.toLocaleString()}. ` +
        `Pro removes the limit.`,
      checkout: checkoutUrl(channel, "pro"),
    };
  }

  // 次数限制
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (!state.usage) state.usage = {};
  if (!state.usage[today]) state.usage[today] = 0;

  const runsToday = state.usage[today];

  if (limits.runsPerDay >= 0 && runsToday >= limits.runsPerDay) {
    return {
      allowed: false,
      reason: "daily_limit",
      runsToday,
      limit: limits.runsPerDay,
      shouldUpsell: true,
      upsellMessage:
        `You've run ${runsToday} validations today — the free daily limit. ` +
        `Pro has no cap and adds cross-table checks.`,
      checkout: checkoutUrl(channel, "pro"),
    };
  }

  // 记账
  state.usage[today] = runsToday + 1;
  state.lastChannel = channel;
  state.lastRun = new Date().toISOString();

  // 清理 30 天前的记录
  const cutoff = new Date(Date.now() - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  state.usage = Object.fromEntries(
    Object.entries(state.usage).filter(([d]) => d >= cutoff)
  );
  saveState(state);

  // 用到 80% 时温和提示
  let shouldUpsell = false;
  let msg = "";
  if (limits.runsPerDay > 0) {
    const pct = (runsToday + 1) / limits.runsPerDay;
    if (pct >= 0.8) {
      shouldUpsell = true;
      msg =
        `You've used ${runsToday + 1} of ${limits.runsPerDay} free validations today. ` +
        `Pro removes the cap and adds cross-table consistency + alerts — $49 once.`;
    }
  }

  return {
    allowed: true,
    reason: "ok",
    runsToday: runsToday + 1,
    limit: limits.runsPerDay,
    shouldUpsell,
    upsellMessage: msg,
    checkout: shouldUpsell ? checkoutUrl(channel, "pro") : "",
  };
}

// ============================================================
// 归因
// ============================================================
function attribution(channel, extra = {}) {
  return {
    channel: CHANNELS[channel] || channel,
    ts: new Date().toISOString(),
    version: "1.0.1",
    ...extra,
  };
}

// ============================================================
// 升级文案（按渠道定制）
// ============================================================
function upsellText(channel) {
  const url = checkoutUrl(channel, "pro");
  const texts = {
    n8n: `**Data Validator Pro — $49 once**

The free node covers duplicates, empty required fields, placeholder values, type mismatches, impossible dates and whitespace.

Pro adds what actually costs you money when it silently breaks:

- **Cross-table consistency** — verify keys match between two branches before you merge
- **Alerts** — Slack, email or webhook when a run finds problems
- **5M rows** per run

[Get Pro →](${url})`,
    cli: `Pro ($49 once): cross-table checks, alert webhooks, no row or run limits.
[Get Pro →](${url})`,
    mcp: `Pro unlocks \`validate_cross_table\` and \`watch_dataset\`.
[Get Pro →](${url})`,
  };
  return texts[channel] || texts.cli;
}

module.exports = {
  CHANNELS,
  PLANS,
  FREE_LIMITS,
  PRO_LIMITS,
  checkoutUrl,
  verifyLicense,
  resolveLicense,
  checkUsage,
  attribution,
  upsellText,
  loadState,
  saveState,
};
