/**
 * n8n-nodes-datacheck — 包入口
 *
 * n8n 会读取 package.json 里的 n8n.nodes 数组加载节点，
 * 这个 index.js 主要用于兼容某些加载方式。
 */
"use strict";

const { DataValidator } = require("./nodes/DataValidator.node.js");

module.exports = {
  nodes: [DataValidator],
};
