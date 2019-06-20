"use strict";

const parser = require("@ali/vx-ast-parser");

function parse(contents) {
  const code = "<>" + (contents || "").trimRight() + "</>";

  const plugins = [
    "jsx",
    "optionalChaining",
    ["decorators", { decoratorsBeforeExport: true }],
    "objectRestSpread",
    ["pipelineOperator", { proposal: "minimal" }]
  ];

  const out = parser.parse(code, {
    jsxTopLevel: true,
    plugins
  });

  return out;
}

module.exports = parse;
