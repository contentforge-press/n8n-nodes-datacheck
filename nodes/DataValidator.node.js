/**
 * Data Validator Node for n8n
 *
 * 在 n8n 工作流中间插入一步校验，捕获那些「不报错但悄悄错」的数据问题。
 *
 * 免费版：重复行、空值、占位符、类型、日期真实性
 * Pro 版：跨表一致性、告警、超大文件
 */
const { validate } = require("../core/validator.js");

class DataValidator {
  constructor() {
    this.description = {
      displayName: "Data Validator",
      name: "dataValidator",
      group: ["transform"],
      version: 1,
      description:
        "Catch duplicates, impossible dates and broken numbers before they reach the next node",
      defaults: { name: "Data Validator" },
      inputs: ["main"],
      outputs: ["main", "main"],
      outputNames: ["Valid", "Issues found"],
      credentials: [
        {
          name: "dataValidatorApi",
          required: false,
          displayOptions: {
            show: { "/operation": ["advanced"] },
          },
        },
      ],
      properties: [
        {
          displayName: "Operation",
          name: "operation",
          type: "options",
          options: [
            {
              name: "Validate Rows",
              value: "validate",
              description: "Check each item for data problems",
            },
            {
              name: "Profile Columns",
              value: "profile",
              description: "Infer column types and find mismatches",
            },
            {
              name: "Check Duplicates",
              value: "duplicates",
              description: "Find rows or key values that repeat",
            },
          ],
          default: "validate",
        },
        {
          displayName: "Key Column",
          name: "keyColumn",
          type: "string",
          default: "",
          placeholder: "order_id",
          description:
            "Column that should be unique. Leave empty to skip the key check.",
          displayOptions: {
            show: { "/operation": ["validate", "duplicates"] },
          },
        },
        {
          displayName: "Required Columns",
          name: "requiredColumns",
          type: "string",
          default: "",
          placeholder: "email, amount",
          description: "Comma-separated. Rows missing these are flagged.",
          displayOptions: {
            show: { "/operation": ["validate"] },
          },
        },
        {
          displayName: "Behavior On Issues",
          name: "onIssues",
          type: "options",
          options: [
            { name: "Split — send bad rows to output 2", value: "split" },
            { name: "Pass Through — annotate and continue", value: "annotate" },
            { name: "Stop — fail the workflow", value: "stop" },
          ],
          default: "split",
        },
        {
          displayName: "Minimum Score",
          name: "minScore",
          type: "number",
          default: 0,
          description:
            "Fail the workflow if the health score is below this. 0 disables.",
        },
      ],
    };
  }

  async execute() {
    const items = this.getInputData();
    const operation = this.getNodeParameter("operation", 0);
    const keyColumn = this.getNodeParameter("keyColumn", 0, "");
    const requiredRaw = this.getNodeParameter("requiredColumns", 0, "");
    const onIssues = this.getNodeParameter("onIssues", 0);
    const minScore = this.getNodeParameter("minScore", 0, 0);

    const required = requiredRaw
      ? requiredRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    // 把 n8n items 转成 CSV 字符串，复用共享内核
    if (!items.length) {
      return [items, []];
    }

    const headers = Object.keys(items[0].json);
    const lines = [headers.join(",")];

    for (const item of items) {
      const row = headers.map((h) => {
        const v = item.json[h];
        if (v === null || v === undefined) return "";
        const s = String(v);
        // 需要引号的情况
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      });
      lines.push(row.join(","));
    }

    const result = validate(lines.join("\n"), {
      keyColumn: keyColumn || undefined,
      requiredColumns: required,
    });

    // 健康分门槛
    if (minScore > 0 && result.score < minScore) {
      throw new Error(
        `Data health score ${result.score} is below the minimum of ${minScore}. ` +
          `${result.counts.high} high-severity issues found. ${result.summary}`
      );
    }

    // 找出有问题的行
    const badRowNumbers = new Set(result.issues.map((i) => i.row));

    const goodItems = [];
    const badItems = [];

    items.forEach((item, idx) => {
      const csvRowNum = idx + 2; // 表头是 1
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

    // 汇总 item（总是第一个输出）
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

    if (onIssues === "split") {
      return [[summaryItem, ...goodItems], badItems];
    }

    if (onIssues === "annotate") {
      return [[summaryItem, ...goodItems, ...badItems], []];
    }

    // stop 模式在 score 达标时正常返回
    return [[summaryItem, ...goodItems, ...badItems], []];
  }
}

module.exports = { DataValidator };
