"use strict";

const core = require("./main/core");

const internalPlugins = [require("./language-visionx")];

const isArray =
  Array.isArray ||
  function(arr) {
    return Object.prototype.toString.call(arr) === "[object Array]";
  };

// Luckily `opts` is always the 2nd argument
function withPlugins(fn) {
  return function() {
    const args = Array.from(arguments);
    let plugins = (args[1] && args[1].plugins) || [];
    if (!isArray(plugins)) {
      plugins = Object.values(plugins);
    }
    args[1] = Object.assign({}, args[1], {
      plugins: internalPlugins.concat(plugins)
    });
    return fn.apply(null, args);
  };
}

const formatWithCursor = withPlugins(core.formatWithCursor);

const RE_SPACES = /^ */;
const RE_COMMENT_BEFORE = /<!--(?:.*?)-->(?<!$)/;
function format(text, opts = { parser: "visionx-parse" }) {
  let code = formatWithCursor(text, opts).formatted;
  const lines = code.split('\n').slice(2, -3);
  if (!lines[0]) {
    return '\n';
  }

  const m = RE_SPACES.exec(lines[0]);
  if (m[0].length < 1) {
    return lines.join('\n') + '\n';
  }
  const eatLength = m[0].length;

  return lines.map(line => {
    line = line.slice(eatLength);
    let m = RE_COMMENT_BEFORE.exec(line);
    if (!m) {
      return line;
    }
    const fill = '\n' + RE_SPACES.exec(line)[0];
    const segments = [];
    do {
      const e = m.index + m[0].length;
      segments.push(line.slice(0, e) + fill);
      line = line.slice(e);
    } while (m);
    return segments.join('') + line;
  }).join('\n') + '\n';
}

module.exports = format;
