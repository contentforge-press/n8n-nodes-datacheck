/**
 * 共享校验内核 · JavaScript 实现（CommonJS）
 *
 * 与 validator.py 行为一致，可在 node / n8n / 浏览器中直接运行。
 * 零依赖。
 */

"use strict";

const PLACEHOLDERS = new Set([
  "n/a", "na", "n.a.", "null", "nil", "none", "-", "--", "—",
  "unknown", "tbd", "tba", "#n/a", "#value!", "nan", "undefined",
]);

/** 解析 CSV */
function parseCSV(text) {
  const lines = [];
  let cur = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") {
        cur.push(field); field = "";
        if (cur.some((x) => x !== "")) lines.push(cur);
        cur = [];
      } else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field !== "" || cur.length) {
    cur.push(field);
    if (cur.some((x) => x !== "")) lines.push(cur);
  }

  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].map((h) => h.trim());
  const rows = lines.slice(1);
  for (const r of rows) while (r.length < headers.length) r.push("");
  return { headers, rows };
}

/** 检查日期是否真实存在 */
function checkDate(raw) {
  const s = (raw || "").trim();
  if (!s) return { valid: true };

  let y = 0, mo = 0, d = 0, m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    y = +m[3]; mo = +m[1]; d = +m[2];
  } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else {
    return { valid: false, reason: "unparseable date format" };
  }

  if (mo < 1 || mo > 12) return { valid: false, reason: `month ${mo} is invalid` };
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) {
    return { valid: false, reason: `day ${d} does not exist in ${y}-${String(mo).padStart(2, "0")}` };
  }
  return { valid: true };
}

/** 解析金额 */
function parseMoney(raw) {
  const s = (raw || "").trim();
  if (!s) return { ok: true };

  const negative = /^\(.*\)$/.test(s);
  let t = s.replace(/^\(/, "").replace(/\)$/, "").replace(/[$€£¥,\s]/g, "");

  let mult = 1;
  if (/k$/i.test(t)) { mult = 1000; t = t.slice(0, -1); }
  else if (/m$/i.test(t)) { mult = 1e6; t = t.slice(0, -1); }

  if (!/^-?\d*\.?\d+$/.test(t)) return { ok: false };
  const v = parseFloat(t) * mult;
  return { ok: true, value: negative ? -v : v };
}

function isPlaceholder(v) {
  return PLACEHOLDERS.has((v || "").trim().toLowerCase());
}

function inferColumnType(values) {
  const nonEmpty = values.filter((v) => (v || "").trim() && !isPlaceholder(v));
  if (!nonEmpty.length) return "empty";

  let num = 0, date = 0, money = 0;
  for (const v of nonEmpty) {
    if (checkDate(v).valid) date++;
    if (parseMoney(v).ok && /[\d$€£¥]/.test(v)) { money++; num++; }
    else if (/^-?\d*\.?\d+$/.test((v || "").trim())) num++;
  }
  const n = nonEmpty.length;
  // 日期判定：看「格式像日期」的比例，而不是「日期是否真实存在」
  // 这样 2026-02-30 这种坏值也能归入 date 列并被检出
  let dateFormat = 0;
  for (const v of nonEmpty) {
    if (/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{8})$/.test(v.trim())) {
      dateFormat++;
    }
  }
  if (dateFormat / n > 0.7) return "date";
  if (/[$€£¥,]/.test(nonEmpty.join("")) && money / n > 0.8) return "money";
  if (num / n > 0.8) return "number";
  if (num / n > 0.2 && num / n < 0.8) return "mixed";
  return "string";
}

/** 归一化 key：A-001 == A-1 */
function normalizeKey(v) {
  let s = (v || "").trim().toLowerCase();
  const m = s.match(/^([a-z]+)-?(\d+)$/);
  if (m) return m[1] + "-" + parseInt(m[2], 10);
  return s.replace(/^0+(?=\d)/, "");
}

/** 主校验函数 */
function validate(csvText, options) {
  options = options || {};
  const { headers, rows } = parseCSV(csvText);
  const issues = [];

  if (!headers.length) {
    return {
      score: 100, totalRows: 0, totalColumns: 0, issues: [],
      counts: { high: 0, mid: 0, low: 0 }, columns: [],
      lossyRows: [], summary: "No data",
    };
  }

  // 列画像
  const columns = headers.map((name, idx) => {
    const values = rows.map((r) => r[idx] ?? "");
    const nonEmpty = values.filter((v) => (v || "").trim() && !isPlaceholder(v));
    const uniq = new Set(nonEmpty.map((v) => v.trim()));
    const inferred = inferColumnType(values);

    let mismatch = 0;
    if (inferred === "number") {
      for (const v of nonEmpty) {
        if (!/^-?\d*\.?\d+$/.test(v.trim()) && !parseMoney(v).ok) mismatch++;
      }
    } else if (inferred === "date") {
      for (const v of nonEmpty) if (!checkDate(v).valid) mismatch++;
    }

    return {
      name, index: idx, inferredType: inferred,
      totalRows: rows.length,
      emptyCount: values.length - nonEmpty.length,
      uniqueCount: uniq.size,
      typeMismatchRate: nonEmpty.length ? mismatch / nonEmpty.length : 0,
      samples: nonEmpty.slice(0, 3),
    };
  });

  // 1. 完全重复行
  const seenRows = new Map();
  rows.forEach((r, i) => {
    const key = r.join("\u0001");
    if (seenRows.has(key)) {
      issues.push({
        type: "duplicate_row", severity: "high", column: "(whole row)",
        row: i + 2, value: r.slice(0, 3).join(","),
        reason: `identical to row ${seenRows.get(key) + 2}`,
        fix: "remove the duplicate row, or add a unique identifier",
      });
    } else seenRows.set(key, i);
  });

  // 2. 主键重复
  if (options.keyColumn) {
    const ki = headers.findIndex(
      (h) => h.toLowerCase() === options.keyColumn.toLowerCase()
    );
    if (ki >= 0) {
      const seenKey = new Map();
      rows.forEach((r, i) => {
        const v = normalizeKey(r[ki] ?? "");
        if (!v) return;
        if (seenKey.has(v)) {
          issues.push({
            type: "duplicate_key", severity: "high", column: headers[ki],
            row: i + 2, value: r[ki] ?? "",
            reason: `key repeats (first seen at row ${seenKey.get(v) + 2})`,
            fix: "a join on this column will produce duplicate output rows",
          });
        } else seenKey.set(v, i);
      });
    }
  }

  // 3. 占位符
  rows.forEach((r, i) => {
    r.forEach((v, ci) => {
      if (ci < headers.length && isPlaceholder(v)) {
        issues.push({
          type: "placeholder_value", severity: "mid", column: headers[ci],
          row: i + 2, value: v,
          reason: `"${v.trim()}" looks like a value but is a placeholder`,
          fix: "replace with empty string, or fill the real value",
        });
      }
    });
  });

  // 4. 必填列为空
  for (const rc of options.requiredColumns || []) {
    const ci = headers.findIndex((h) => h.toLowerCase() === rc.toLowerCase());
    if (ci < 0) continue;
    rows.forEach((r, i) => {
      const v = (r[ci] ?? "").trim();
      if (!v || isPlaceholder(v)) {
        issues.push({
          type: "empty_required", severity: "high", column: headers[ci],
          row: i + 2, value: v,
          reason: "required column is empty",
          fix: "fill it, or the row may be silently dropped downstream",
        });
      }
    });
  }

  // 5. 按列类型检查
  for (const col of columns) {
    if (col.inferredType === "empty" || col.inferredType === "string") continue;
    rows.forEach((r, i) => {
      const v = (r[col.index] ?? "").trim();
      if (!v || isPlaceholder(v)) return;

      if (col.inferredType === "date") {
        const d = checkDate(v);
        if (!d.valid) {
          const impossible = (d.reason || "").includes("does not exist");
          issues.push({
            type: impossible ? "impossible_date" : "invalid_date",
            severity: "high", column: col.name, row: i + 2, value: v,
            reason: d.reason || "unparseable date",
            fix: "normalize to YYYY-MM-DD, then re-validate",
          });
        }
      } else if (col.inferredType === "number" || col.inferredType === "money") {
        const isNum = /^-?\d*\.?\d+$/.test(v);
        if (!isNum && !parseMoney(v).ok) {
          issues.push({
            type: "invalid_number", severity: "high", column: col.name,
            row: i + 2, value: v,
            reason: `column is ${col.inferredType} but this value is not`,
            fix: "this row will fail a numeric cast and may vanish",
          });
        }
      }
    });
  }

  // 6. 空白
  rows.forEach((r, i) => {
    r.forEach((v, ci) => {
      if (ci < headers.length && v !== v.trim() && v.trim()) {
        issues.push({
          type: "whitespace", severity: "low", column: headers[ci],
          row: i + 2, value: v,
          reason: "leading or trailing whitespace",
          fix: "breaks string joins and unique constraints",
        });
      }
    });
  });

  // 统计
  const counts = { high: 0, mid: 0, low: 0 };
  for (const it of issues) counts[it.severity]++;

  const lossySet = new Set();
  for (const it of issues) if (it.severity === "high") lossySet.add(it.row);
  const lossyRows = Array.from(lossySet).sort((a, b) => a - b);

  const rowCount = Math.max(rows.length, 1);
  const penalty =
    (counts.high * 100) / rowCount * 0.8 +
    (counts.mid * 100) / rowCount * 0.35 +
    (counts.low * 100) / rowCount * 0.1;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  let summary;
  if (score >= 95) summary = "Clean. Nothing would break downstream.";
  else if (score >= 80) summary = "Minor issues. Safe to process with care.";
  else if (score >= 60) summary = "Real problems. Some rows would be silently lost.";
  else summary = "Serious problems. Do not load this as-is.";

  return {
    score, totalRows: rows.length, totalColumns: headers.length,
    issues, counts, columns, lossyRows, summary,
  };
}

function toMarkdown(r) {
  const lines = [];
  lines.push("# Data Health Report");
  lines.push("");
  lines.push(`**Score: ${r.score}/100** — ${r.summary}`);
  lines.push("");
  lines.push(`- Rows: ${r.totalRows}`);
  lines.push(`- Columns: ${r.totalColumns}`);
  lines.push(`- High severity: ${r.counts.high}`);
  lines.push(`- Rows that would be lost: ${r.lossyRows.length}`);
  lines.push("");
  if (r.issues.length) {
    lines.push("## Issues");
    lines.push("");
    lines.push("| Row | Column | Value | Problem | Fix |");
    lines.push("|---|---|---|---|---|");
    for (const it of r.issues.slice(0, 100)) {
      lines.push(`| ${it.row} | ${it.column} | \`${it.value.slice(0, 20)}\` | ${it.reason} | ${it.fix} |`);
    }
    if (r.issues.length > 100) lines.push(`| … | | | ${r.issues.length - 100} more | |`);
  }
  return lines.join("\n");
}

module.exports = {
  parseCSV, checkDate, parseMoney, normalizeKey,
  inferColumnType, isPlaceholder, validate, toMarkdown,
};
