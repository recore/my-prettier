"use strict";

const parse = require("./parser");
const locFns = require("./parser/loc");
const { hasPragma } = require("./parser");
const printVisionX = require("./printer");

const languages = [
  {
    name: "Recore VisionX",
    extensions: [".vx", ".vsx"],
    vscodeLanguageIds: ["visionx"],
    parsers: ["visionx-parse"]
  }
];

const parsers = {
  "visionx-parse": {
    parse,
    astFormat: "visionx-ast",
    hasPragma,
    locStart: locFns.locStart,
    locEnd: locFns.locEnd
  }
};

const printers = {
  "visionx-ast": printVisionX
};

module.exports = {
  languages,
  parsers,
  printers
};
