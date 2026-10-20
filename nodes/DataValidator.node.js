/**
 * Data Validator Node for n8n — 带内建销售引擎
 *
 * 销售逻辑全部在节点内部：
 *   · 免费版：单表校验，100 次/天，1 万行
 *   · Pro 版：跨表一致性 + 告警 + 500 万行
 *   · 用到 80% 时在节点输出里带升级提示
 *   · 不阻断免费使用，只在真超限时拒绝
 */
const { validate } = require("../core/validator.js");
const selling = require("../core/selling.js");

class DataValidator {
  constructor() {
    this.description = {
      displayName: "Data Validator",
      name: "dataValidator",
      group: ["transform"],
      version: 1,
      description:
        "Catch duplicates, impossible dates and silent data loss before they reach the next node",
      defaults: { name: "Data Validator" },
      inputs: ["main"],
      outputs: ["main", "main"],
      outputNames: ["Valid", "Issues found"],
      credentials: [
        {
          name: "dataValidatorPro",
          required: false,
          displayName: "Data Validator Pro License",
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
              description: "Infer column types and flag mismatched values",
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
          description: "Column that should be unique (A-001 and A-1 count as the same key)",
        },
        {
          displayName: "Required Columns",
          name: "requiredColumns",
          type: "string",
          default: "",
          placeholder: "email, amount",
          description: "Comma-separated. Rows missing these are flagged as high severity.",
        },
        {
          displayName: "Behavior On Issues",
          name: "onIssues",
          type: "options",
          options: [
            {
              name: "Split — send bad rows to output 2",
              value: "split",
            },
            {
              name: "Annotate — pass everything through",
              value: "annotate",
            },
            {
              name: "Stop — fail the workflow",
              value: "stop",
            },
          ],
          default: "split",
        },
        {
          displayName: "Minimum Score",
          name: "minScore",
          type: "number",
          default: 0,
          description: "Fail the workflow if the health score is below this. 0 disables.",
        },
        {
          displayName: "Include Upgrade Hint",
          name: "includeHint",
          type: "boolean",
          default: true,
          description:
            "Show a one-line upgrade hint in the output when approaching the free limit. No emails, no tracking.",
        },
      ],
    };
  }

  /** 把 n8n items 转成 CSV 字符串 */
  itemsToCSV(items) {
    if (!items.length) return "";
    const headers = Object.keys(items[0].json).filter(
      (k) => !k.startsWith("_")
    );
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
    return lines.join("\n");
  }

  async execute() {
    const items = this.getInputData();

    // 读参数
    const operation = this.getNodeParameter("operation", 0, "validate");
    const keyColumn = this.getNodeParameter("keyColumn", 0, "");
    const requiredRaw = this.getNodeParameter("requiredColumns", 0, "");
    const onIssues = this.getNodeParameter("onIssues", 0, "split");
    const minScore = this.getNodeParameter("minScore", 0, 0);
    const includeHint = this.getNodeParameter("includeHint", 0, true);

    const required = requiredRaw
      ? requiredRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    if (!items.length) {
      return [[], []];
    }

    // ===== 销售引擎：许可 + 用量 =====
    let credentials = null;
    try {
      credentials = await this.getCredentials("dataValidatorPro");
    } catch {
      // 没配凭据就是免费用户
    }

    const license = selling.resolveLicense(credentials);
    const usage = selling.checkUsage(license, "n8n", items.length);

    // 超限：明确告诉用户为什么失败，以及怎么解决
    if (!usage.allowed) {
      throw new Error(
        `${usage.upsellMessage}\n\nUpgrade: ${usage.checkout}`
      );
    }

    // ===== 执行校验 =====
    const csv = this.itemsToCSV(items);

    if (operation === "profile") {
      const result = validate(csv);
      const profileItem = {
        json: {
          _profile: result.columns.map((c) => ({
            name: c.name,
            type: c.inferredType,
            empty: c.emptyCount,
            unique: c.uniqueCount,
            samples: c.samples,
          })),
          _score: result.score,
          _summary: result.summary,
        },
      };
      return [[profileItem], []];
    }

    const result = validate(csv, {
      keyColumn: keyColumn || undefined,
      requiredColumns: required,
    });

    // 健康分门槛
    if (minScore > 0 && result.score < minScore) {
      throw new Error(
        `Data health score ${result.score} is below the minimum of ${minScore}. ` +
          `${result.counts.high} high-severity issues. ${result.summary}`
      );
    }

    // ===== 分流 =====
    const goodItems = [];
    const badItems = [];

    items.forEach((item, idx) => {
      const rowNum = idx + 2;
      const rowIssues = result.issues.filter((i) => i.row === rowNum);
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

    // ===== 汇总（含销售引擎的提示）=====
    const summaryData = {
      score: result.score,
      totalRows: result.totalRows,
      totalColumns: result.totalColumns,
      high: result.counts.high,
      mid: result.counts.mid,
      low: result.counts.low,
      rowsAtRisk: result.lossyRows.length,
      message: result.summary,
      tier: license.valid ? license.plan : "free",
      runsToday: usage.runsToday,
    };

    // 只在需要时提示，且用户可以选择关掉
    if (includeHint && usage.shouldUpsell) {
      summaryData.upgradeHint = usage.upsellMessage;
      summaryData.upgradeUrl = usage.checkout;
    }

    const summaryItem = { json: { _summary: summaryData } };

    if (onIssues === "split") {
      return [[summaryItem, ...goodItems], badItems];
    }
    return [[summaryItem, ...goodItems, ...badItems], []];
  }
}

module.exports = { DataValidator };
