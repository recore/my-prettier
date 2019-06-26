"use strict";

// We need to use `eval("require")()` to prevent rollup from hoisting the requires. A babel
// plugin will look for `eval("require")()` and transform to `require()` in the bundle,
// and rewrite the paths to require from the top-level.

// We need to list the parsers and getters so we can load them only when necessary.
module.exports = [
  // JS
  require("../language-js"),
  {
    parsers: {
      // JS - TypeScript
      get typescript() {
        return eval("require")("../language-js/parser-typescript").parsers
          .typescript;
      },
      /**
       * TODO: Remove this old alias in a major version
       */
      get "typescript-eslint"() {
        return eval("require")("../language-js/parser-typescript").parsers
          .typescript;
      }
    }
  }
];
