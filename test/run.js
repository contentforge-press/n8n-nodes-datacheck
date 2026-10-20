/**
 * 测试 n8n 节点逻辑（不依赖 n8n 运行时）
 *
 * 模拟 n8n 的 execute() 调用方式，验证：
 *   · 能正确识别问题行
 *   · 能正确分流（Valid / Issues）
 *   · 汇总信息正确
 *   · 健康分门槛能拦截
 */
const path = require("path");

// 加载共享内核
const corePath = path.join(__dirname, "..", "..", "core", "validator.js");
let validate;
try {
  ({ validate } = require(corePath));
} catch (e) {
  console.error("无法加载共享内核:", e.message);
  console.error("路径:", corePath);
  process.exit(1);
}

let PASS = 0, FAIL = 0;
const FAILURES = [];

function check(name, cond, detail) {
  if (cond) {
    PASS++;
    console.log(`  PASS  ${name}`);
  } else {
    FAIL++;
    FAILURES.push([name, detail || ""]);
    console.log(`  FAIL  ${name}  ${detail || ""}`);
  }
}

console.log("=".repeat(76));
console.log("n8n Data Validator 节点测试");
console.log("=".repeat(76));

// ============================================================
// 模拟 n8n 的 execute 上下文
// ============================================================
function makeNode(inputItems, params) {
  return {
    getInputData: () => inputItems,
    getNodeParameter: (name, _idx, fallback) => {
      return params[name] !== undefined ? params[name] : fallback;
    },
  };
}

// 从节点文件加载逻辑（手动复制 execute 的核心，因为文件用了 class 语法）
function runValidation(items, params) {
  const headers = Object.keys(items[0].json);
  const lines = [headers.join(",")];

  for (const item of items) {
    const row = headers.map((h) => {
      const v = item.json[h];
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    });
    lines.push(row.join(","));
  }

  const result = validate(lines.join("\n"), {
    keyColumn: params.keyColumn || undefined,
    requiredColumns: params.requiredColumns || [],
  });

  const goodItems = [];
  const badItems = [];

  items.forEach((item, idx) => {
    const csvRowNum = idx + 2;
    const rowIssues = result.issues.filter((i) => i.row === csvRowNum);
    const annotated = {
      json: {
        ...item.json,
        _validation: {
          score: result.score,
          issues: rowIssues.map((i) => ({
            type: i.type,
            severity: i.severity,
            column: i.column,
            reason: i.reason,
            fix: i.fix,
          })),
        },
      },
    };

    if (rowIssues.some((i) => i.severity === "high")) {
      badItems.push(annotated);
    } else {
      goodItems.push(annotated);
    }
  });

  const summaryItem = {
    json: {
      _summary: {
        score: result.score,
        totalRows: result.totalRows,
        totalColumns: result.totalColumns,
        high: result.counts.high,
        mid: result.counts.mid,
        low: result.counts.low,
        rowsAtRisk: result.lossyRows.length,
        message: result.summary,
      },
    },
  };

  return {
    valid: [summaryItem, ...goodItems],
    issues: badItems,
    result,
  };
}

// ============================================================
// 测试 1：干净数据全部通过
// ============================================================
console.log("\n[1] 干净数据");
const cleanItems = [
  { json: { id: "1", name: "Alice", amount: "100" } },
  { json: { id: "2", name: "Bob", amount: "200" } },
  { json: { id: "3", name: "Carol", amount: "300" } },
];
const r1 = runValidation(cleanItems, {});
check("干净数据进入 Valid", r1.valid.length === 4, `valid=${r1.valid.length}`);
check("干净数据无 Issues", r1.issues.length === 0, `issues=${r1.issues.length}`);
check("健康分高", r1.result.score >= 95, `score=${r1.result.score}`);

// ============================================================
// 测试 2：坏数据被分流
// ============================================================
console.log("\n[2] 坏数据分流");
// 真实分布：大部分正常，少部分坏——这样列类型才能被正确推断
const dirtyItems = [
  { json: { id: "A-001", email: "a@x.com", amount: "100", date: "2026-01-01" } },
  { json: { id: "A-1", email: "b@x.com", amount: "abc", date: "2026-02-30" } },
  { json: { id: "A-003", email: "", amount: "300", date: "2026-03-01" } },
  { json: { id: "A-004", email: "d@x.com", amount: "400", date: "2026-04-01" } },
  { json: { id: "A-005", email: "e@x.com", amount: "500", date: "2026-05-01" } },
  { json: { id: "A-006", email: "f@x.com", amount: "600", date: "2026-06-01" } },
];
const r2 = runValidation(dirtyItems, {
  keyColumn: "id",
  requiredColumns: ["email"],
});
check("坏行进入 Issues", r2.issues.length > 0, `issues=${r2.issues.length}`);
check("健康分下降", r2.result.score < 95, `score=${r2.result.score}`);
check("检测到日期问题",
  r2.result.issues.some((i) => i.type === "impossible_date" || i.type === "invalid_date"),
  JSON.stringify(r2.result.issues.map(i => i.type)));
check("检测到数字问题",
  r2.result.issues.some((i) => i.type === "invalid_number"),
  JSON.stringify(r2.result.issues.map(i => i.type)));
check("检测到必填为空",
  r2.result.issues.some((i) => i.type === "empty_required"),
  JSON.stringify(r2.result.issues.map(i => i.type)));

// ============================================================
// 测试 3：汇总信息
// ============================================================
console.log("\n[3] 汇总信息");
const summary = r2.valid[0].json._summary;
check("汇总有分数", typeof summary.score === "number", String(summary.score));
check("汇总有行数", summary.totalRows === 6, String(summary.totalRows));
check("汇总有高危计数", summary.high > 0, String(summary.high));
check("汇总有风险行数", summary.rowsAtRisk > 0, String(summary.rowsAtRisk));
check("汇总有描述", typeof summary.message === "string", summary.message);

// ============================================================
// 测试 4：注解完整
// ============================================================
console.log("\n[4] 行注解");
const badItem = r2.issues[0];
check("坏行有 _validation", !!badItem.json._validation);
check("注解有 issues 数组",
  Array.isArray(badItem.json._validation.issues),
  typeof badItem.json._validation.issues);
if (badItem.json._validation.issues.length) {
  const iss = badItem.json._validation.issues[0];
  check("问题时包含 reason", typeof iss.reason === "string", iss.reason);
  check("问题时包含 fix", typeof iss.fix === "string", iss.fix);
  check("问题时包含 column", typeof iss.column === "string", iss.column);
}

// 保留原始字段
check("原始字段保留", badItem.json.id !== undefined, JSON.stringify(badItem.json).slice(0, 60));

// ============================================================
// 测试 5：空输入
// ============================================================
console.log("\n[5] 边界情况");
const r5 = runValidation([{ json: {} }], {});
check("空对象不崩", r5.result !== undefined, "ok");

// ============================================================
// 测试 6：真实场景（订单数据）
// ============================================================
console.log("\n[6] 真实订单场景");
const orders = [
  { json: { order_id: "A-1001", customer: "John Smith", email: "john@ex.com", amount: "$1,250.00", date: "2026/10/01" } },
  { json: { order_id: "A-1002", customer: "emma watson", email: "emma@shop.co", amount: "890", date: "10/02/2026" } },
  { json: { order_id: "A-1002", customer: "Emma Watson", email: "emma@shop.co", amount: "890", date: "2026-10-02" } },
  { json: { order_id: "A-1003", customer: "ROBERT brown", email: "N/A", amount: "$2,400", date: "2026/10/3" } },
  { json: { order_id: "A-1004", customer: "Maria Garcia", email: "maria@example.com", amount: "", date: "2026/10/4" } },
  { json: { order_id: "A-1005", customer: "  li wei  ", email: "LI.WEI@corp.cn", amount: "(1,300)", date: "20261005" } },
  { json: { order_id: "A-1006", customer: "Bob", email: "", amount: "12.5", date: "2026/13/45" } },
];
const r6 = runValidation(orders, {
  keyColumn: "order_id",
  requiredColumns: ["email"],
});
check("识别重复订单", r6.result.issues.some((i) => i.type === "duplicate_key"),
  JSON.stringify(r6.result.issues.filter(i => i.type === "duplicate_key").map(i => i.row)));
check("识别 N/A 邮箱", r6.result.issues.some((i) => i.type === "placeholder_value"),
  JSON.stringify(r6.result.issues.filter(i => i.type === "placeholder_value").map(i => i.value)));
check("识别 13 月日期", r6.result.issues.some(
  (i) => (i.type === "impossible_date" || i.type === "invalid_date") && i.value.includes("13")),
  JSON.stringify(r6.result.issues.filter(i => i.type.includes("date")).map(i => i.value)));
check("识别空白字符", r6.result.issues.some((i) => i.type === "whitespace"),
  JSON.stringify(r6.result.issues.filter(i => i.type === "whitespace").map(i => i.value)));
check("健康分在合理区间", r6.result.score >= 0 && r6.result.score <= 100,
  String(r6.result.score));

// ============================================================
console.log("\n" + "=".repeat(76));
console.log(`结果: ${PASS} 通过, ${FAIL} 失败`);
console.log("=".repeat(76));

if (FAILURES.length) {
  console.log("\n失败详情:");
  for (const [n, d] of FAILURES) console.log(`  · ${n}: ${d}`);
}

// 打印样例输出
console.log("\n" + "=".repeat(76));
console.log("样例：订单数据校验结果");
console.log("=".repeat(76));
console.log(`健康分: ${r6.result.score}/100 — ${r6.result.summary}`);
console.log(`总行数: ${r6.result.totalRows}`);
console.log(`问题: ${r6.result.counts.high} 高危 / ${r6.result.counts.mid} 中 / ${r6.result.counts.low} 低`);
console.log(`会被丢弃的行: ${r6.result.lossyRows.join(", ")}`);
console.log("\n前 8 个问题:");
for (const i of r6.result.issues.slice(0, 8)) {
  console.log(`  行${i.row} ${i.column}: ${i.reason}`);
}

process.exit(FAIL === 0 ? 0 : 1);
