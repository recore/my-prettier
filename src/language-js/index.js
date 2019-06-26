"use strict";

const estreePrinter = require("./printer-estree");
const options = require("./options");
const createLanguage = require("../utils/create-language");

const languages = [
  createLanguage(require("linguist-languages/data/typescript"), {
    override: {
      since: "1.4.0",
      parsers: ["typescript"],
      vscodeLanguageIds: ["typescript", "typescriptreact"]
    }
  })
];

const printers = {
  estree: estreePrinter
};

module.exports = {
  languages,
  options,
  printers
};
