"use strict";

// TODO(azz): anything that imports from main shouldn't be in a `language-*` dir.
const comments = require("./comments");
const {
  isNextLineEmpty,
  hasNewline,
  getLast,
  printString,
  hasIgnoreComment,
  skipWhitespace,
  matchAncestorTypes,
  getPenultimate,
  getPreferredQuote,
  printNumber,
  hasFlowAnnotationComment,
  hasFlowShorthandAnnotationComment,
  getNextNonSpaceNonCommentCharacterIndex,
  isNextLineEmptyAfterIndex
} = require("../../common/utils");
const embed = require("./embed");
const clean = require("./clean");
const { insertPragma } = require("../parser/pragma");
const handleComments = require("./comments");
const pathNeedsParens = require("./needs-parens");
const {
  printHtmlBinding,
  isVueEventBindingExpression
} = require("./html-binding");

const {
  builders: {
    concat,
    join,
    line,
    hardline,
    softline,
    group,
    indent,
    align,
    conditionalGroup,
    breakParent,
    fill,
    ifBreak,
    lineSuffixBoundary,
    dedent
  },
  utils: { willBreak, isLineNext, isEmpty }
} = require("../../doc");

function genericPrint(path, options, printPath, args) {
  const node = path.getValue();
  let needsParens = false;
  const linesWithoutParens = printPathNoParens(path, options, printPath, args);

  if (!node || isEmpty(linesWithoutParens)) {
    return linesWithoutParens;
  }

  // Nodes with decorators can't have parentheses, so we can avoid
  // computing pathNeedsParens() except in this case.
  needsParens = pathNeedsParens(path, options);

  const parts = [];
  if (needsParens) {
    parts.unshift("(");
  }

  parts.push(linesWithoutParens);

  if (needsParens) {
    const node = path.getValue();
    if (hasFlowShorthandAnnotationComment(node)) {
      parts.push(" /*");
      parts.push(node.trailingComments[0].value.trimLeft());
      parts.push("*/");
      node.trailingComments[0].printed = true;
    }

    parts.push(")");
  }

  return concat(parts);
}

function shouldPrintComma(options, level) {
  level = level || "es5";

  switch (options.trailingComma) {
    case "all":
      if (level === "all") {
        return true;
      }
    // fallthrough
    case "es5":
      if (level === "es5") {
        return true;
      }
    // fallthrough
    case "none":
    default:
      return false;
  }
}

function hasPrettierIgnore(path) {
  return hasIgnoreComment(path) || hasJsxIgnoreComment(path);
}

function hasJsxIgnoreComment(path) {
  const node = path.getValue();
  const parent = path.getParentNode();
  if (!parent || !node || !isJSXNode(node) || !isJSXNode(parent)) {
    return false;
  }

  // Lookup the previous sibling, ignoring any empty JSXText elements
  const index = parent.children.indexOf(node);
  let prevSibling = null;
  for (let i = index; i > 0; i--) {
    const candidate = parent.children[i - 1];
    if (candidate.type === "JSXText" && !isMeaningfulJSXText(candidate)) {
      continue;
    }
    prevSibling = candidate;
    break;
  }

  return (
    prevSibling &&
    prevSibling.type === "JSXExpressionContainer" &&
    prevSibling.expression.type === "JSXEmptyExpression" &&
    prevSibling.expression.comments &&
    prevSibling.expression.comments.find(
      comment => comment.value.trim() === "prettier-ignore"
    )
  );
}

/**
 * The following is the shared logic for
 * ternary operators, namely ConditionalExpression
 * and TSConditionalType
 * @typedef {Object} OperatorOptions
 * @property {() => Array<string | Doc>} beforeParts - Parts to print before the `?`.
 * @property {(breakClosingParen: boolean) => Array<string | Doc>} afterParts - Parts to print after the conditional expression.
 * @property {boolean} shouldCheckJsx - Whether to check for and print in JSX mode.
 * @property {string} conditionalNodeType - The type of the conditional expression node, ie "ConditionalExpression" or "TSConditionalType".
 * @property {string} consequentNodePropertyName - The property at which the consequent node can be found on the main node, eg "consequent".
 * @property {string} alternateNodePropertyName - The property at which the alternate node can be found on the main node, eg "alternate".
 * @property {string} testNodePropertyName - The property at which the test node can be found on the main node, eg "test".
 * @property {boolean} breakNested - Whether to break all nested ternaries when one breaks.
 * @param {FastPath} path - The path to the ConditionalExpression/TSConditionalType node.
 * @param {Options} options - Prettier options
 * @param {Function} print - Print function to call recursively
 * @param {OperatorOptions} operatorOptions
 * @returns Doc
 */
function printTernaryOperator(path, options, print, operatorOptions) {
  const node = path.getValue();
  const testNode = node[operatorOptions.testNodePropertyName];
  const consequentNode = node[operatorOptions.consequentNodePropertyName];
  const alternateNode = node[operatorOptions.alternateNodePropertyName];
  const parts = [];

  // We print a ConditionalExpression in either "JSX mode" or "normal mode".
  // See tests/jsx/conditional-expression.js for more info.
  let jsxMode = false;
  const parent = path.getParentNode();
  let forceNoIndent = parent.type === operatorOptions.conditionalNodeType;

  // Find the outermost non-ConditionalExpression parent, and the outermost
  // ConditionalExpression parent. We'll use these to determine if we should
  // print in JSX mode.
  let currentParent;
  let previousParent;
  let i = 0;
  do {
    previousParent = currentParent || node;
    currentParent = path.getParentNode(i);
    i++;
  } while (
    currentParent &&
    currentParent.type === operatorOptions.conditionalNodeType
  );
  const firstNonConditionalParent = currentParent || parent;
  const lastConditionalParent = previousParent;

  if (
    operatorOptions.shouldCheckJsx &&
    (isJSXNode(testNode) ||
      isJSXNode(consequentNode) ||
      isJSXNode(alternateNode) ||
      conditionalExpressionChainContainsJSX(lastConditionalParent))
  ) {
    jsxMode = true;
    forceNoIndent = true;

    // Even though they don't need parens, we wrap (almost) everything in
    // parens when using ?: within JSX, because the parens are analogous to
    // curly braces in an if statement.
    const wrap = doc =>
      concat([
        ifBreak("(", ""),
        indent(concat([softline, doc])),
        softline,
        ifBreak(")", "")
      ]);

    // The only things we don't wrap are:
    // * Nested conditional expressions in alternates
    // * null
    const isNull = node =>
      node.type === "NullLiteral" ||
      (node.type === "Literal" && node.value === null);

    parts.push(
      " ? ",
      isNull(consequentNode)
        ? path.call(print, operatorOptions.consequentNodePropertyName)
        : wrap(path.call(print, operatorOptions.consequentNodePropertyName)),
      " : ",
      alternateNode.type === operatorOptions.conditionalNodeType ||
        isNull(alternateNode)
        ? path.call(print, operatorOptions.alternateNodePropertyName)
        : wrap(path.call(print, operatorOptions.alternateNodePropertyName))
    );
  } else {
    // normal mode
    const part = concat([
      line,
      "? ",
      consequentNode.type === operatorOptions.conditionalNodeType
        ? ifBreak("", "(")
        : "",
      align(2, path.call(print, operatorOptions.consequentNodePropertyName)),
      consequentNode.type === operatorOptions.conditionalNodeType
        ? ifBreak("", ")")
        : "",
      line,
      ": ",
      alternateNode.type === operatorOptions.conditionalNodeType
        ? path.call(print, operatorOptions.alternateNodePropertyName)
        : align(2, path.call(print, operatorOptions.alternateNodePropertyName))
    ]);
    parts.push(
      parent.type !== operatorOptions.conditionalNodeType ||
        parent[operatorOptions.alternateNodePropertyName] === node
        ? part
        : options.useTabs
        ? dedent(indent(part))
        : align(Math.max(0, options.tabWidth - 2), part)
    );
  }

  // We want a whole chain of ConditionalExpressions to all
  // break if any of them break. That means we should only group around the
  // outer-most ConditionalExpression.
  const maybeGroup = doc =>
    operatorOptions.breakNested
      ? parent === firstNonConditionalParent
        ? group(doc)
        : doc
      : group(doc);

  // Break the closing paren to keep the chain right after it:
  // (a
  //   ? b
  //   : c
  // ).call()
  const breakClosingParen =
    !jsxMode &&
    (parent.type === "MemberExpression" ||
      parent.type === "OptionalMemberExpression") &&
    !parent.computed;

  return maybeGroup(
    concat(
      [].concat(
        (testDoc =>
          /**
           *     a
           *       ? b
           *       : multiline
           *         test
           *         node
           *       ^^ align(2)
           *       ? d
           *       : e
           */
          parent.type === operatorOptions.conditionalNodeType &&
          parent[operatorOptions.alternateNodePropertyName] === node
            ? align(2, testDoc)
            : testDoc)(concat(operatorOptions.beforeParts())),
        forceNoIndent ? concat(parts) : indent(concat(parts)),
        operatorOptions.afterParts(breakClosingParen)
      )
    )
  );
}

function printPathNoParens(path, options, print) {
  const n = path.getValue();
  const semi = options.semi ? ";" : "";

  if (!n) {
    return "";
  }

  if (typeof n === "string") {
    return n;
  }

  const htmlBinding = printHtmlBinding(path, options, print);
  if (htmlBinding) {
    return htmlBinding;
  }

  const parts = [];
  switch (n.type) {
    case "File":
      // Print @babel/parser's InterpreterDirective here so that
      // leading comments on the `Program` node get printed after the hashbang.
      if (n.program && n.program.interpreter) {
        parts.push(
          path.call(
            programPath => programPath.call(print, "interpreter"),
            "program"
          )
        );
      }

      parts.push(path.call(print, "program"));

      return concat(parts);

    case "Program":
      // Babel 6
      if (n.directives) {
        path.each(childPath => {
          parts.push(print(childPath), semi, hardline);
          if (
            isNextLineEmpty(options.originalText, childPath.getValue(), options)
          ) {
            parts.push(hardline);
          }
        }, "directives");
      }

      parts.push(
        path.call(bodyPath => {
          return printStatementSequence(bodyPath, options, print);
        }, "body")
      );

      parts.push(
        comments.printDanglingComments(path, options, /* sameIndent */ true)
      );

      // Only force a trailing newline if there were any contents.
      if (n.body.length || n.comments) {
        parts.push(hardline);
      }

      return concat(parts);
    case "ConditionalExpression":
      return printTernaryOperator(path, options, print, {
        beforeParts: () => [path.call(print, "test")],
        afterParts: breakClosingParen => [breakClosingParen ? softline : ""],
        shouldCheckJsx: true,
        conditionalNodeType: "ConditionalExpression",
        consequentNodePropertyName: "consequent",
        alternateNodePropertyName: "alternate",
        testNodePropertyName: "test",
        breakNested: true
      });
    case "BooleanLiteral": // Babel 6 Literal split
    case "StringLiteral": // Babel 6 Literal split
    case "Literal": {
      if (n.regex) {
        return printRegex(n.regex);
      }
      if (typeof n.value === "number") {
        return printNumber(n.raw);
      }
      if (typeof n.value !== "string") {
        return "" + n.value;
      }
      // TypeScript workaround for https://github.com/JamesHenry/typescript-estree/issues/2
      // See corresponding workaround in needs-parens.js
      const grandParent = path.getParentNode(1);
      const isTypeScriptDirective =
        options.parser === "typescript" &&
        typeof n.value === "string" &&
        grandParent &&
        (grandParent.type === "Program" ||
          grandParent.type === "BlockStatement");

      return nodeStr(n, options, isTypeScriptDirective);
    }
    case "Identifier": {
      return concat([
        n.name,
        printOptionalToken(path),
        printTypeAnnotation(path, options, print)
      ]);
    }
    case "SpreadElement":
    case "SpreadElementPattern":
    case "RestProperty":
    case "SpreadProperty":
    case "SpreadPropertyPattern":
    case "RestElement":
    case "ObjectTypeSpreadProperty":
      return concat([
        "...",
        path.call(print, "argument"),
        printTypeAnnotation(path, options, print)
      ]);
    case "ExpressionStatement":
      // Detect Flow-parsed directives
      if (n.directive) {
        return concat([nodeStr(n.expression, options, true), semi]);
      }

      if (options.parser === "__vue_event_binding") {
        const parent = path.getParentNode();
        if (
          parent.type === "Program" &&
          parent.body.length === 1 &&
          parent.body[0] === n
        ) {
          return concat([
            path.call(print, "expression"),
            isVueEventBindingExpression(n.expression) ? ";" : ""
          ]);
        }
      }

      // Do not append semicolon after the only JSX element in a program
      return concat([
        path.call(print, "expression"),
        isTheOnlyJSXElementInMarkdown(options, path) ? "" : semi
      ]); // Babel extension.
    case "ArrayExpression":
    case "ArrayPattern":
      if (n.elements.length === 0) {
        if (!hasDanglingComments(n)) {
          parts.push("[]");
        } else {
          parts.push(
            group(
              concat([
                "[",
                comments.printDanglingComments(path, options),
                softline,
                "]"
              ])
            )
          );
        }
      } else {
        const lastElem = getLast(n.elements);
        const canHaveTrailingComma = !(
          lastElem && lastElem.type === "RestElement"
        );

        // JavaScript allows you to have empty elements in an array which
        // changes its length based on the number of commas. The algorithm
        // is that if the last argument is null, we need to force insert
        // a comma to ensure JavaScript recognizes it.
        //   [,].length === 1
        //   [1,].length === 1
        //   [1,,].length === 2
        //
        // Note that getLast returns null if the array is empty, but
        // we already check for an empty array just above so we are safe
        const needsForcedTrailingComma =
          canHaveTrailingComma && lastElem === null;

        parts.push(
          group(
            concat([
              "[",
              indent(
                concat([
                  softline,
                  printArrayItems(path, options, "elements", print)
                ])
              ),
              needsForcedTrailingComma ? "," : "",
              ifBreak(
                canHaveTrailingComma &&
                  !needsForcedTrailingComma &&
                  shouldPrintComma(options)
                  ? ","
                  : ""
              ),
              comments.printDanglingComments(
                path,
                options,
                /* sameIndent */ true
              ),
              softline,
              "]"
            ])
          )
        );
      }

      parts.push(
        printOptionalToken(path),
        printTypeAnnotation(path, options, print)
      );

      return concat(parts);
    case "MemberExpression": {
      const parent = path.getParentNode();
      let firstNonMemberParent;
      let i = 0;
      do {
        firstNonMemberParent = path.getParentNode(i);
        i++;
      } while (
        firstNonMemberParent &&
        (firstNonMemberParent.type === "MemberExpression" ||
          firstNonMemberParent.type === "OptionalMemberExpression" ||
          firstNonMemberParent.type === "TSNonNullExpression")
      );

      const shouldInline =
        (firstNonMemberParent &&
          (firstNonMemberParent.type === "NewExpression" ||
            firstNonMemberParent.type === "BindExpression" ||
            (firstNonMemberParent.type === "VariableDeclarator" &&
              firstNonMemberParent.id.type !== "Identifier") ||
            (firstNonMemberParent.type === "AssignmentExpression" &&
              firstNonMemberParent.left.type !== "Identifier"))) ||
        n.computed ||
        (n.object.type === "Identifier" &&
          n.property.type === "Identifier" &&
          parent.type !== "MemberExpression" &&
          parent.type !== "OptionalMemberExpression");

      return concat([
        path.call(print, "object"),
        shouldInline
          ? printMemberLookup(path, options, print)
          : group(
              indent(
                concat([softline, printMemberLookup(path, options, print)])
              )
            )
      ]);
    }
    case "MetaProperty":
      return concat([
        path.call(print, "meta"),
        ".",
        path.call(print, "property")
      ]);
    case "CallExpression": {
      const isNew = n.type === "NewExpression";

      const optional = printOptionalToken(path);
      if (
        // We want to keep CommonJS- and AMD-style require calls, and AMD-style
        // define calls, as a unit.
        // e.g. `define(["some/lib", (lib) => {`
        (!isNew &&
          n.callee.type === "Identifier" &&
          (n.callee.name === "require" || n.callee.name === "define")) ||
        // Template literals as single arguments
        (n.arguments.length === 1 &&
          isTemplateOnItsOwnLine(
            n.arguments[0],
            options.originalText,
            options
          )) ||
        // Keep test declarations on a single line
        // e.g. `it('long name', () => {`
        (!isNew && isTestCall(n, path.getParentNode()))
      ) {
        return concat([
          isNew ? "new " : "",
          path.call(print, "callee"),
          optional,
          printFunctionTypeParameters(path, options, print),
          concat(["(", join(", ", path.map(print, "arguments")), ")"])
        ]);
      }

      // Inline Flow annotation comments following Identifiers in Call nodes need to
      // stay with the Identifier. For example:
      //
      // foo /*:: <SomeGeneric> */(bar);
      //
      // Here, we ensure that such comments stay between the Identifier and the Callee.
      const isIdentifierWithFlowAnnotation =
        n.callee.type === "Identifier" &&
        hasFlowAnnotationComment(n.callee.trailingComments);
      if (isIdentifierWithFlowAnnotation) {
        n.callee.trailingComments[0].printed = true;
      }

      // We detect calls on member lookups and possibly print them in a
      // special chain format. See `printMemberChain` for more info.
      if (!isNew && isMemberish(n.callee)) {
        return printMemberChain(path, options, print);
      }

      return concat([
        isNew ? "new " : "",
        path.call(print, "callee"),
        optional,
        isIdentifierWithFlowAnnotation
          ? `/*:: ${n.callee.trailingComments[0].value.substring(2).trim()} */`
          : "",
        printFunctionTypeParameters(path, options, print),
        printArgumentsList(path, options, print)
      ]);
    }
    case "NumericLiteral": // Babel 6 Literal split
      return printNumber(n.extra.raw);
    case "JSXAttribute":
      parts.push(path.call(print, "name"));

      if (n.value) {
        let res;
        if (isStringLiteral(n.value)) {
          const raw = rawText(n.value);
          // Unescape all quotes so we get an accurate preferred quote
          let final = raw.replace(/&apos;/g, "'").replace(/&quot;/g, '"');
          const quote = getPreferredQuote(
            final,
            options.jsxSingleQuote ? "'" : '"'
          );
          const escape = quote === "'" ? "&apos;" : "&quot;";
          final = final.slice(1, -1).replace(new RegExp(quote, "g"), escape);
          res = concat([quote, final, quote]);
        } else {
          res = path.call(print, "value");
        }
        parts.push("=", res);
      }

      return concat(parts);
    case "JSXIdentifier":
      return "" + n.name;
    case "JSXNamespacedName":
      return join(":", [
        path.call(print, "namespace"),
        path.call(print, "name")
      ]);
    case "JSXMemberExpression":
      return join(".", [
        path.call(print, "object"),
        path.call(print, "property")
      ]);
    case "TSQualifiedName":
      return join(".", [path.call(print, "left"), path.call(print, "right")]);
    case "JSXSpreadAttribute":
    case "JSXSpreadChild": {
      return concat([
        "{",
        path.call(
          p => {
            const printed = concat(["...", print(p)]);
            const n = p.getValue();
            if (!n.comments || !n.comments.length) {
              return printed;
            }
            return concat([
              indent(
                concat([
                  softline,
                  comments.printComments(p, () => printed, options)
                ])
              ),
              softline
            ]);
          },
          n.type === "JSXSpreadAttribute" ? "argument" : "expression"
        ),
        "}"
      ]);
    }
    case "JSXExpressionContainer": {
      const parent = path.getParentNode(0);

      const preventInline =
        parent.type === "JSXAttribute" &&
        n.expression.comments &&
        n.expression.comments.length > 0;

      const shouldInline =
        !preventInline &&
        (n.expression.type === "ArrayExpression" ||
          n.expression.type === "ObjectExpression" ||
          n.expression.type === "ArrowFunctionExpression" ||
          n.expression.type === "CallExpression" ||
          n.expression.type === "OptionalCallExpression" ||
          n.expression.type === "FunctionExpression" ||
          n.expression.type === "JSXEmptyExpression" ||
          n.expression.type === "TemplateLiteral" ||
          n.expression.type === "TaggedTemplateExpression" ||
          n.expression.type === "DoExpression" ||
          (isJSXNode(parent) &&
            (n.expression.type === "ConditionalExpression" ||
              isBinaryish(n.expression))));

      if (shouldInline) {
        return group(
          concat(["{", path.call(print, "expression"), lineSuffixBoundary, "}"])
        );
      }

      return group(
        concat([
          "{",
          indent(concat([softline, path.call(print, "expression")])),
          softline,
          lineSuffixBoundary,
          "}"
        ])
      );
    }
    case "JSXFragment":
    case "JSXElement": {
      const elem = comments.printComments(
        path,
        () => printJSXElement(path, options, print),
        options
      );
      return maybeWrapJSXElementInParens(path, elem);
    }
    case "JSXOpeningElement": {
      const n = path.getValue();

      const nameHasComments =
        n.name && n.name.comments && n.name.comments.length > 0;

      // Don't break self-closing elements with no attributes and no comments
      if (n.selfClosing && !n.attributes.length && !nameHasComments) {
        return concat([
          "<",
          path.call(print, "name"),
          path.call(print, "typeParameters"),
          " />"
        ]);
      }

      // don't break up opening elements with a single long text attribute
      if (
        n.attributes &&
        n.attributes.length === 1 &&
        n.attributes[0].value &&
        isStringLiteral(n.attributes[0].value) &&
        !n.attributes[0].value.value.includes("\n") &&
        // We should break for the following cases:
        // <div
        //   // comment
        //   attr="value"
        // >
        // <div
        //   attr="value"
        //   // comment
        // >
        !nameHasComments &&
        (!n.attributes[0].comments || !n.attributes[0].comments.length)
      ) {
        return group(
          concat([
            "<",
            path.call(print, "name"),
            path.call(print, "typeParameters"),
            " ",
            concat(path.map(print, "attributes")),
            n.selfClosing ? " />" : ">"
          ])
        );
      }

      const lastAttrHasTrailingComments =
        n.attributes.length && hasTrailingComment(getLast(n.attributes));

      const bracketSameLine =
        // Simple tags (no attributes and no comment in tag name) should be
        // kept unbroken regardless of `jsxBracketSameLine`
        (!n.attributes.length && !nameHasComments) ||
        (options.jsxBracketSameLine &&
          // We should print the bracket in a new line for the following cases:
          // <div
          //   // comment
          // >
          // <div
          //   attr // comment
          // >
          (!nameHasComments || n.attributes.length) &&
          !lastAttrHasTrailingComments);

      // We should print the opening element expanded if any prop value is a
      // string literal with newlines
      const shouldBreak =
        n.attributes &&
        n.attributes.some(
          attr =>
            attr.value &&
            isStringLiteral(attr.value) &&
            attr.value.value.includes("\n")
        );

      return group(
        concat([
          "<",
          path.call(print, "name"),
          path.call(print, "typeParameters"),
          concat([
            indent(
              concat(
                path.map(attr => concat([line, print(attr)]), "attributes")
              )
            ),
            n.selfClosing ? line : bracketSameLine ? ">" : softline
          ]),
          n.selfClosing ? "/>" : bracketSameLine ? "" : ">"
        ]),
        { shouldBreak }
      );
    }
    case "JSXClosingElement":
      return concat(["</", path.call(print, "name"), ">"]);
    case "JSXOpeningFragment":
    case "JSXClosingFragment": {
      const hasComment = n.comments && n.comments.length;
      const hasOwnLineComment =
        hasComment && !n.comments.every(handleComments.isBlockComment);
      const isOpeningFragment = n.type === "JSXOpeningFragment";
      return concat([
        isOpeningFragment ? "<" : "</",
        indent(
          concat([
            hasOwnLineComment
              ? hardline
              : hasComment && !isOpeningFragment
              ? " "
              : "",
            comments.printDanglingComments(path, options, true)
          ])
        ),
        hasOwnLineComment ? hardline : "",
        ">"
      ]);
    }
    case "JSXText":
      /* istanbul ignore next */
      throw new Error("JSXTest should be handled by JSXElement");
    case "JSXEmptyExpression": {
      const requiresHardline =
        n.comments && !n.comments.every(handleComments.isBlockComment);

      return concat([
        comments.printDanglingComments(
          path,
          options,
          /* sameIndent */ !requiresHardline
        ),
        requiresHardline ? hardline : ""
      ]);
    }
    // These types are unprintable because they serve as abstract
    // supertypes for other (printable) types.
    case "Comment":
      /* istanbul ignore next */
      throw new Error("unprintable type: " + JSON.stringify(n.type));
    default:
      /* istanbul ignore next */
      throw new Error("unknown type: " + JSON.stringify(n.type));
  }
}

function isJSXNode(node) {
  return node.type === "JSXElement" || node.type === "JSXFragment";
}

function isEmptyJSXElement(node) {
  if (node.children.length === 0) {
    return true;
  }
  if (node.children.length > 1) {
    return false;
  }

  // if there is one text child and does not contain any meaningful text
  // we can treat the element as empty.
  const child = node.children[0];
  return isLiteral(child) && !isMeaningfulJSXText(child);
}

// Only space, newline, carriage return, and tab are treated as whitespace
// inside JSX.
const jsxWhitespaceChars = " \n\r\t";
const containsNonJsxWhitespaceRegex = new RegExp(
  "[^" + jsxWhitespaceChars + "]"
);
const matchJsxWhitespaceRegex = new RegExp("([" + jsxWhitespaceChars + "]+)");

// Meaningful if it contains non-whitespace characters,
// or it contains whitespace without a new line.
function isMeaningfulJSXText(node) {
  return (
    isLiteral(node) &&
    (containsNonJsxWhitespaceRegex.test(rawText(node)) ||
      !/\n/.test(rawText(node)))
  );
}

// Detect an expression node representing `{" "}`
function isJSXWhitespaceExpression(node) {
  return (
    node.type === "JSXExpressionContainer" &&
    isLiteral(node.expression) &&
    node.expression.value === " " &&
    !node.expression.comments
  );
}

function separatorNoWhitespace(
  isFacebookTranslationTag,
  child,
  childNode,
  nextNode
) {
  if (isFacebookTranslationTag) {
    return "";
  }

  if (
    (childNode.type === "JSXElement" && !childNode.closingElement) ||
    (nextNode && (nextNode.type === "JSXElement" && !nextNode.closingElement))
  ) {
    return child.length === 1 ? softline : hardline;
  }

  return softline;
}

function separatorWithWhitespace(
  isFacebookTranslationTag,
  child,
  childNode,
  nextNode
) {
  if (isFacebookTranslationTag) {
    return hardline;
  }

  if (child.length === 1) {
    return (childNode.type === "JSXElement" && !childNode.closingElement) ||
      (nextNode && nextNode.type === "JSXElement" && !nextNode.closingElement)
      ? hardline
      : softline;
  }

  return hardline;
}

// JSX Children are strange, mostly for two reasons:
// 1. JSX reads newlines into string values, instead of skipping them like JS
// 2. up to one whitespace between elements within a line is significant,
//    but not between lines.
//
// Leading, trailing, and lone whitespace all need to
// turn themselves into the rather ugly `{' '}` when breaking.
//
// We print JSX using the `fill` doc primitive.
// This requires that we give it an array of alternating
// content and whitespace elements.
// To ensure this we add dummy `""` content elements as needed.
function printJSXChildren(
  path,
  options,
  print,
  jsxWhitespace,
  isFacebookTranslationTag
) {
  const n = path.getValue();
  const children = [];

  // using `map` instead of `each` because it provides `i`
  path.map((childPath, i) => {
    const child = childPath.getValue();
    if (isLiteral(child)) {
      const text = rawText(child);

      // Contains a non-whitespace character
      if (isMeaningfulJSXText(child)) {
        const words = text.split(matchJsxWhitespaceRegex);

        // Starts with whitespace
        if (words[0] === "") {
          children.push("");
          words.shift();
          if (/\n/.test(words[0])) {
            const next = n.children[i + 1];
            children.push(
              separatorWithWhitespace(
                isFacebookTranslationTag,
                words[1],
                child,
                next
              )
            );
          } else {
            children.push(jsxWhitespace);
          }
          words.shift();
        }

        let endWhitespace;
        // Ends with whitespace
        if (getLast(words) === "") {
          words.pop();
          endWhitespace = words.pop();
        }

        // This was whitespace only without a new line.
        if (words.length === 0) {
          return;
        }

        words.forEach((word, i) => {
          if (i % 2 === 1) {
            children.push(line);
          } else {
            children.push(word);
          }
        });

        if (endWhitespace !== undefined) {
          if (/\n/.test(endWhitespace)) {
            const next = n.children[i + 1];
            children.push(
              separatorWithWhitespace(
                isFacebookTranslationTag,
                getLast(children),
                child,
                next
              )
            );
          } else {
            children.push(jsxWhitespace);
          }
        } else {
          const next = n.children[i + 1];
          children.push(
            separatorNoWhitespace(
              isFacebookTranslationTag,
              getLast(children),
              child,
              next
            )
          );
        }
      } else if (/\n/.test(text)) {
        // Keep (up to one) blank line between tags/expressions/text.
        // Note: We don't keep blank lines between text elements.
        if (text.match(/\n/g).length > 1) {
          children.push("");
          children.push(hardline);
        }
      } else {
        children.push("");
        children.push(jsxWhitespace);
      }
    } else {
      const printedChild = print(childPath);
      children.push(printedChild);

      const next = n.children[i + 1];
      const directlyFollowedByMeaningfulText =
        next && isMeaningfulJSXText(next);
      if (directlyFollowedByMeaningfulText) {
        const firstWord = rawText(next)
          .trim()
          .split(matchJsxWhitespaceRegex)[0];
        children.push(
          separatorNoWhitespace(
            isFacebookTranslationTag,
            firstWord,
            child,
            next
          )
        );
      } else {
        children.push(hardline);
      }
    }
  }, "children");

  return children;
}

// JSX expands children from the inside-out, instead of the outside-in.
// This is both to break children before attributes,
// and to ensure that when children break, their parents do as well.
//
// Any element that is written without any newlines and fits on a single line
// is left that way.
// Not only that, any user-written-line containing multiple JSX siblings
// should also be kept on one line if possible,
// so each user-written-line is wrapped in its own group.
//
// Elements that contain newlines or don't fit on a single line (recursively)
// are fully-split, using hardline and shouldBreak: true.
//
// To support that case properly, all leading and trailing spaces
// are stripped from the list of children, and replaced with a single hardline.
function printJSXElement(path, options, print) {
  const n = path.getValue();

  // Turn <div></div> into <div />
  if (n.type === "JSXElement" && isEmptyJSXElement(n)) {
    n.openingElement.selfClosing = true;
    return path.call(print, "openingElement");
  }

  const openingLines =
    n.type === "JSXElement"
      ? path.call(print, "openingElement")
      : path.call(print, "openingFragment");
  const closingLines =
    n.type === "JSXElement"
      ? path.call(print, "closingElement")
      : path.call(print, "closingFragment");

  if (
    n.children.length === 1 &&
    n.children[0].type === "JSXExpressionContainer" &&
    (n.children[0].expression.type === "TemplateLiteral" ||
      n.children[0].expression.type === "TaggedTemplateExpression")
  ) {
    return concat([
      openingLines,
      concat(path.map(print, "children")),
      closingLines
    ]);
  }

  // Convert `{" "}` to text nodes containing a space.
  // This makes it easy to turn them into `jsxWhitespace` which
  // can then print as either a space or `{" "}` when breaking.
  n.children = n.children.map(child => {
    if (isJSXWhitespaceExpression(child)) {
      return {
        type: "JSXText",
        value: " ",
        raw: " "
      };
    }
    return child;
  });

  const containsTag = n.children.filter(isJSXNode).length > 0;
  const containsMultipleExpressions =
    n.children.filter(child => child.type === "JSXExpressionContainer").length >
    1;
  const containsMultipleAttributes =
    n.type === "JSXElement" && n.openingElement.attributes.length > 1;

  // Record any breaks. Should never go from true to false, only false to true.
  let forcedBreak =
    willBreak(openingLines) ||
    containsTag ||
    containsMultipleAttributes ||
    containsMultipleExpressions;

  const rawJsxWhitespace = options.singleQuote ? "{' '}" : '{" "}';
  const jsxWhitespace = ifBreak(concat([rawJsxWhitespace, softline]), " ");

  const isFacebookTranslationTag =
    n.openingElement &&
    n.openingElement.name &&
    n.openingElement.name.name === "fbt";

  const children = printJSXChildren(
    path,
    options,
    print,
    jsxWhitespace,
    isFacebookTranslationTag
  );

  const containsText =
    n.children.filter(child => isMeaningfulJSXText(child)).length > 0;

  // We can end up we multiple whitespace elements with empty string
  // content between them.
  // We need to remove empty whitespace and softlines before JSX whitespace
  // to get the correct output.
  for (let i = children.length - 2; i >= 0; i--) {
    const isPairOfEmptyStrings = children[i] === "" && children[i + 1] === "";
    const isPairOfHardlines =
      children[i] === hardline &&
      children[i + 1] === "" &&
      children[i + 2] === hardline;
    const isLineFollowedByJSXWhitespace =
      (children[i] === softline || children[i] === hardline) &&
      children[i + 1] === "" &&
      children[i + 2] === jsxWhitespace;
    const isJSXWhitespaceFollowedByLine =
      children[i] === jsxWhitespace &&
      children[i + 1] === "" &&
      (children[i + 2] === softline || children[i + 2] === hardline);
    const isDoubleJSXWhitespace =
      children[i] === jsxWhitespace &&
      children[i + 1] === "" &&
      children[i + 2] === jsxWhitespace;
    const isPairOfHardOrSoftLines =
      (children[i] === softline &&
        children[i + 1] === "" &&
        children[i + 2] === hardline) ||
      (children[i] === hardline &&
        children[i + 1] === "" &&
        children[i + 2] === softline);

    if (
      (isPairOfHardlines && containsText) ||
      isPairOfEmptyStrings ||
      isLineFollowedByJSXWhitespace ||
      isDoubleJSXWhitespace ||
      isPairOfHardOrSoftLines
    ) {
      children.splice(i, 2);
    } else if (isJSXWhitespaceFollowedByLine) {
      children.splice(i + 1, 2);
    }
  }

  // Trim trailing lines (or empty strings)
  while (
    children.length &&
    (isLineNext(getLast(children)) || isEmpty(getLast(children)))
  ) {
    children.pop();
  }

  // Trim leading lines (or empty strings)
  while (
    children.length &&
    (isLineNext(children[0]) || isEmpty(children[0])) &&
    (isLineNext(children[1]) || isEmpty(children[1]))
  ) {
    children.shift();
    children.shift();
  }

  // Tweak how we format children if outputting this element over multiple lines.
  // Also detect whether we will force this element to output over multiple lines.
  const multilineChildren = [];
  children.forEach((child, i) => {
    // There are a number of situations where we need to ensure we display
    // whitespace as `{" "}` when outputting this element over multiple lines.
    if (child === jsxWhitespace) {
      if (i === 1 && children[i - 1] === "") {
        if (children.length === 2) {
          // Solitary whitespace
          multilineChildren.push(rawJsxWhitespace);
          return;
        }
        // Leading whitespace
        multilineChildren.push(concat([rawJsxWhitespace, hardline]));
        return;
      } else if (i === children.length - 1) {
        // Trailing whitespace
        multilineChildren.push(rawJsxWhitespace);
        return;
      } else if (children[i - 1] === "" && children[i - 2] === hardline) {
        // Whitespace after line break
        multilineChildren.push(rawJsxWhitespace);
        return;
      }
    }

    multilineChildren.push(child);

    if (willBreak(child)) {
      forcedBreak = true;
    }
  });

  // If there is text we use `fill` to fit as much onto each line as possible.
  // When there is no text (just tags and expressions) we use `group`
  // to output each on a separate line.
  const content = containsText
    ? fill(multilineChildren)
    : group(concat(multilineChildren), { shouldBreak: true });

  const multiLineElem = group(
    concat([
      openingLines,
      indent(concat([hardline, content])),
      hardline,
      closingLines
    ])
  );

  if (forcedBreak) {
    return multiLineElem;
  }

  return conditionalGroup([
    group(concat([openingLines, concat(children), closingLines])),
    multiLineElem
  ]);
}

function maybeWrapJSXElementInParens(path, elem) {
  const parent = path.getParentNode();
  if (!parent) {
    return elem;
  }

  const NO_WRAP_PARENTS = {
    ArrayExpression: true,
    JSXAttribute: true,
    JSXElement: true,
    JSXExpressionContainer: true,
    JSXFragment: true,
    ExpressionStatement: true,
    CallExpression: true,
    OptionalCallExpression: true,
    ConditionalExpression: true,
    JsExpressionRoot: true
  };
  if (NO_WRAP_PARENTS[parent.type]) {
    return elem;
  }

  const shouldBreak = matchAncestorTypes(path, [
    "ArrowFunctionExpression",
    "CallExpression",
    "JSXExpressionContainer"
  ]);

  return group(
    concat([
      ifBreak("("),
      indent(concat([softline, elem])),
      softline,
      ifBreak(")")
    ]),
    { shouldBreak }
  );
}

function isBinaryish(node) {
  return (
    node.type === "BinaryExpression" ||
    node.type === "LogicalExpression" ||
    node.type === "NGPipeExpression"
  );
}

function nodeStr(node, options, isFlowOrTypeScriptDirectiveLiteral) {
  const raw = rawText(node);
  const isDirectiveLiteral =
    isFlowOrTypeScriptDirectiveLiteral || node.type === "DirectiveLiteral";
  return printString(raw, options, isDirectiveLiteral);
}

function hasTrailingComment(node) {
  return node.comments && node.comments.some(comment => comment.trailing);
}

function isLiteral(node) {
  return (
    node.type === "BooleanLiteral" ||
    node.type === "DirectiveLiteral" ||
    node.type === "Literal" ||
    node.type === "NullLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "RegExpLiteral" ||
    node.type === "StringLiteral" ||
    node.type === "TemplateLiteral" ||
    node.type === "TSTypeLiteral" ||
    node.type === "JSXText"
  );
}

function isStringLiteral(node) {
  return (
    node.type === "StringLiteral" ||
    (node.type === "Literal" && typeof node.value === "string")
  );
}

function isTheOnlyJSXElementInMarkdown(options, path) {
  if (options.parentParser !== "markdown" && options.parentParser !== "mdx") {
    return false;
  }

  const node = path.getNode();

  if (!node.expression || !isJSXNode(node.expression)) {
    return false;
  }

  const parent = path.getParentNode();

  return parent.type === "Program" && parent.body.length == 1;
}

function willPrintOwnComments(path) {
  const node = path.getValue();
  const parent = path.getParentNode();

  return (
    ((node &&
      (isJSXNode(node) ||
        hasFlowShorthandAnnotationComment(node) ||
        (parent &&
          (hasFlowAnnotationComment(node.leadingComments) ||
            hasFlowAnnotationComment(node.trailingComments))))) ||
      (parent &&
        (parent.type === "JSXSpreadAttribute" ||
          parent.type === "JSXSpreadChild"))) &&
    !hasIgnoreComment(path)
  );
}

function canAttachComment(node) {
  return (
    node.type &&
    node.type !== "CommentBlock" &&
    node.type !== "CommentLine" &&
    node.type !== "Line" &&
    node.type !== "Block"
  );
}

function printComment(commentPath, options) {
  const comment = commentPath.getValue();

  switch (comment.type) {
    case "CommentBlock":
    case "Block": {
      if (isIndentableBlockComment(comment)) {
        const printed = printIndentableBlockComment(comment);
        // We need to prevent an edge case of a previous trailing comment
        // printed as a `lineSuffix` which causes the comments to be
        // interleaved. See https://github.com/prettier/prettier/issues/4412
        if (
          comment.trailing &&
          !hasNewline(options.originalText, options.locStart(comment), {
            backwards: true
          })
        ) {
          return concat([hardline, printed]);
        }
        return printed;
      }

      const isInsideFlowComment =
        options.originalText.substr(options.locEnd(comment) - 3, 3) === "*-/";

      return "/*" + comment.value + (isInsideFlowComment ? "*-/" : "*/");
    }
    case "CommentLine":
    case "Line":
      // Print shebangs with the proper comment characters
      if (
        options.originalText.slice(options.locStart(comment)).startsWith("#!")
      ) {
        return "#!" + comment.value.trimRight();
      }
      return "//" + comment.value.trimRight();
    default:
      throw new Error("Not a comment: " + JSON.stringify(comment));
  }
}

function printRegex(node) {
  const flags = node.flags
    .split("")
    .sort()
    .join("");
  return `/${node.pattern}/${flags}`;
}

function isIndentableBlockComment(comment) {
  // If the comment has multiple lines and every line starts with a star
  // we can fix the indentation of each line. The stars in the `/*` and
  // `*/` delimiters are not included in the comment value, so add them
  // back first.
  const lines = `*${comment.value}*`.split("\n");
  return lines.length > 1 && lines.every(line => line.trim()[0] === "*");
}

function printIndentableBlockComment(comment) {
  const lines = comment.value.split("\n");

  return concat([
    "/*",
    join(
      hardline,
      lines.map((line, index) =>
        index === 0
          ? line.trimRight()
          : " " + (index < lines.length - 1 ? line.trim() : line.trimLeft())
      )
    ),
    "*/"
  ]);
}

function rawText(node) {
  return node.extra ? node.extra.raw : node.raw;
}

function conditionalExpressionChainContainsJSX(node) {
  return Boolean(getConditionalChainContents(node).find(isJSXNode));
}

// If we have nested conditional expressions, we want to print them in JSX mode
// if there's at least one JSXElement somewhere in the tree.
//
// A conditional expression chain like this should be printed in normal mode,
// because there aren't JSXElements anywhere in it:
//
// isA ? "A" : isB ? "B" : isC ? "C" : "Unknown";
//
// But a conditional expression chain like this should be printed in JSX mode,
// because there is a JSXElement in the last ConditionalExpression:
//
// isA ? "A" : isB ? "B" : isC ? "C" : <span className="warning">Unknown</span>;
//
// This type of ConditionalExpression chain is structured like this in the AST:
//
// ConditionalExpression {
//   test: ...,
//   consequent: ...,
//   alternate: ConditionalExpression {
//     test: ...,
//     consequent: ...,
//     alternate: ConditionalExpression {
//       test: ...,
//       consequent: ...,
//       alternate: ...,
//     }
//   }
// }
//
// We want to traverse over that shape and convert it into a flat structure so
// that we can find if there's a JSXElement somewhere inside.
function getConditionalChainContents(node) {
  // Given this code:
  //
  // // Using a ConditionalExpression as the consequent is uncommon, but should
  // // be handled.
  // A ? B : C ? D : E ? F ? G : H : I
  //
  // which has this AST:
  //
  // ConditionalExpression {
  //   test: Identifier(A),
  //   consequent: Identifier(B),
  //   alternate: ConditionalExpression {
  //     test: Identifier(C),
  //     consequent: Identifier(D),
  //     alternate: ConditionalExpression {
  //       test: Identifier(E),
  //       consequent: ConditionalExpression {
  //         test: Identifier(F),
  //         consequent: Identifier(G),
  //         alternate: Identifier(H),
  //       },
  //       alternate: Identifier(I),
  //     }
  //   }
  // }
  //
  // we should return this Array:
  //
  // [
  //   Identifier(A),
  //   Identifier(B),
  //   Identifier(C),
  //   Identifier(D),
  //   Identifier(E),
  //   Identifier(F),
  //   Identifier(G),
  //   Identifier(H),
  //   Identifier(I)
  // ];
  //
  // This loses the information about whether each node was the test,
  // consequent, or alternate, but we don't care about that here- we are only
  // flattening this structure to find if there's any JSXElements inside.
  const nonConditionalExpressions = [];

  function recurse(node) {
    if (node.type === "ConditionalExpression") {
      recurse(node.test);
      recurse(node.consequent);
      recurse(node.alternate);
    } else {
      nonConditionalExpressions.push(node);
    }
  }
  recurse(node);

  return nonConditionalExpressions;
}

function printOptionalToken(path) {
  const node = path.getValue();
  if (!node.optional) {
    return "";
  }
  if (
    node.type === "OptionalCallExpression" ||
    (node.type === "OptionalMemberExpression" && node.computed)
  ) {
    return "?.";
  }
  return "?";
}

function printTypeAnnotation(path, options, print) {
  const node = path.getValue();
  if (!node.typeAnnotation) {
    return "";
  }

  const parentNode = path.getParentNode();
  const isDefinite =
    node.definite ||
    (parentNode &&
      parentNode.type === "VariableDeclarator" &&
      parentNode.definite);

  const isFunctionDeclarationIdentifier =
    parentNode.type === "DeclareFunction" && parentNode.id === node;

  if (
    isFlowAnnotationComment(options.originalText, node.typeAnnotation, options)
  ) {
    return concat([" /*: ", path.call(print, "typeAnnotation"), " */"]);
  }

  return concat([
    isFunctionDeclarationIdentifier ? "" : isDefinite ? "!: " : ": ",
    path.call(print, "typeAnnotation")
  ]);
}

function isFlowAnnotationComment(text, typeAnnotation, options) {
  const start = options.locStart(typeAnnotation);
  const end = skipWhitespace(text, options.locEnd(typeAnnotation));
  return text.substr(start, 2) === "/*" && text.substr(end, 2) === "*/";
}

function hasDanglingComments(node) {
  return (
    node.comments &&
    node.comments.some(comment => !comment.leading && !comment.trailing)
  );
}

function printArrayItems(path, options, printPath, print) {
  const printedElements = [];
  let separatorParts = [];

  path.each(childPath => {
    printedElements.push(concat(separatorParts));
    printedElements.push(group(print(childPath)));

    separatorParts = [",", line];
    if (
      childPath.getValue() &&
      isNextLineEmpty(options.originalText, childPath.getValue(), options)
    ) {
      separatorParts.push(softline);
    }
  }, printPath);

  return concat(printedElements);
}

function isTemplateOnItsOwnLine(n, text, options) {
  return (
    ((n.type === "TemplateLiteral" && templateLiteralHasNewLines(n)) ||
      (n.type === "TaggedTemplateExpression" &&
        templateLiteralHasNewLines(n.quasi))) &&
    !hasNewline(text, options.locStart(n), { backwards: true })
  );
}

const unitTestRe = /^(skip|[fx]?(it|describe|test))$/;

// eg; `describe("some string", (done) => {})`
function isTestCall(n) {
  if (n.type !== "CallExpression") {
    return false;
  }
  if (n.arguments.length === 1) {
    if (isUnitTestSetUp(n)) {
      return false;
    }
  } else if (n.arguments.length === 2 || n.arguments.length === 3) {
    if (
      ((n.callee.type === "Identifier" && unitTestRe.test(n.callee.name)) ||
        isSkipOrOnlyBlock(n)) &&
      (isTemplateLiteral(n.arguments[0]) || isStringLiteral(n.arguments[0]))
    ) {
      // it("name", () => { ... }, 2500)
      if (n.arguments[2] && !isNumericLiteral(n.arguments[2])) {
        return false;
      }
      return (
        (n.arguments.length === 2
          ? isFunctionOrArrowExpression(n.arguments[1])
          : isFunctionOrArrowExpressionWithBody(n.arguments[1]) &&
            n.arguments[1].params.length <= 1) || false
      );
    }
  }
  return false;
}

function printFunctionTypeParameters(path, options, print) {
  const fun = path.getValue();
  if (fun.typeArguments) {
    return path.call(print, "typeArguments");
  }
  if (fun.typeParameters) {
    return path.call(print, "typeParameters");
  }
  return "";
}

function isMemberish(node) {
  return (
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression" ||
    (node.type === "BindExpression" && node.object)
  );
}

// We detect calls on member expressions specially to format a
// common pattern better. The pattern we are looking for is this:
//
// arr
//   .map(x => x + 1)
//   .filter(x => x > 10)
//   .some(x => x % 2)
//
// The way it is structured in the AST is via a nested sequence of
// MemberExpression and CallExpression. We need to traverse the AST
// and make groups out of it to print it in the desired way.
function printMemberChain(path, options, print) {
  // The first phase is to linearize the AST by traversing it down.
  //
  //   a().b()
  // has the following AST structure:
  //   CallExpression(MemberExpression(CallExpression(Identifier)))
  // and we transform it into
  //   [Identifier, CallExpression, MemberExpression, CallExpression]
  const printedNodes = [];

  // Here we try to retain one typed empty line after each call expression or
  // the first group whether it is in parentheses or not
  function shouldInsertEmptyLineAfter(node) {
    const originalText = options.originalText;
    const nextCharIndex = getNextNonSpaceNonCommentCharacterIndex(
      originalText,
      node,
      options
    );
    const nextChar = originalText.charAt(nextCharIndex);

    // if it is cut off by a parenthesis, we only account for one typed empty
    // line after that parenthesis
    if (nextChar == ")") {
      return isNextLineEmptyAfterIndex(
        originalText,
        nextCharIndex + 1,
        options
      );
    }

    return isNextLineEmpty(originalText, node, options);
  }

  function rec(path) {
    const node = path.getValue();
    if (
      (node.type === "CallExpression" ||
        node.type === "OptionalCallExpression") &&
      (isMemberish(node.callee) ||
        node.callee.type === "CallExpression" ||
        node.callee.type === "OptionalCallExpression")
    ) {
      printedNodes.unshift({
        node: node,
        printed: concat([
          comments.printComments(
            path,
            () =>
              concat([
                printOptionalToken(path),
                printFunctionTypeParameters(path, options, print),
                printArgumentsList(path, options, print)
              ]),
            options
          ),
          shouldInsertEmptyLineAfter(node) ? hardline : ""
        ])
      });
      path.call(callee => rec(callee), "callee");
    } else if (isMemberish(node)) {
      printedNodes.unshift({
        node: node,
        needsParens: pathNeedsParens(path, options),
        printed: comments.printComments(
          path,
          () =>
            node.type === "OptionalMemberExpression" ||
            node.type === "MemberExpression"
              ? printMemberLookup(path, options, print)
              : printBindExpressionCallee(path, options, print),
          options
        )
      });
      path.call(object => rec(object), "object");
    } else if (node.type === "TSNonNullExpression") {
      printedNodes.unshift({
        node: node,
        printed: comments.printComments(path, () => "!", options)
      });
      path.call(expression => rec(expression), "expression");
    } else {
      printedNodes.unshift({
        node: node,
        printed: path.call(print)
      });
    }
  }
  // Note: the comments of the root node have already been printed, so we
  // need to extract this first call without printing them as they would
  // if handled inside of the recursive call.
  const node = path.getValue();
  printedNodes.unshift({
    node,
    printed: concat([
      printOptionalToken(path),
      printFunctionTypeParameters(path, options, print),
      printArgumentsList(path, options, print)
    ])
  });
  path.call(callee => rec(callee), "callee");

  // Once we have a linear list of printed nodes, we want to create groups out
  // of it.
  //
  //   a().b.c().d().e
  // will be grouped as
  //   [
  //     [Identifier, CallExpression],
  //     [MemberExpression, MemberExpression, CallExpression],
  //     [MemberExpression, CallExpression],
  //     [MemberExpression],
  //   ]
  // so that we can print it as
  //   a()
  //     .b.c()
  //     .d()
  //     .e

  // The first group is the first node followed by
  //   - as many CallExpression as possible
  //       < fn()()() >.something()
  //   - as many array acessors as possible
  //       < fn()[0][1][2] >.something()
  //   - then, as many MemberExpression as possible but the last one
  //       < this.items >.something()
  const groups = [];
  let currentGroup = [printedNodes[0]];
  let i = 1;
  for (; i < printedNodes.length; ++i) {
    if (
      printedNodes[i].node.type === "TSNonNullExpression" ||
      printedNodes[i].node.type === "OptionalCallExpression" ||
      printedNodes[i].node.type === "CallExpression" ||
      ((printedNodes[i].node.type === "MemberExpression" ||
        printedNodes[i].node.type === "OptionalMemberExpression") &&
        printedNodes[i].node.computed &&
        isNumericLiteral(printedNodes[i].node.property))
    ) {
      currentGroup.push(printedNodes[i]);
    } else {
      break;
    }
  }
  if (
    printedNodes[0].node.type !== "CallExpression" &&
    printedNodes[0].node.type !== "OptionalCallExpression"
  ) {
    for (; i + 1 < printedNodes.length; ++i) {
      if (
        isMemberish(printedNodes[i].node) &&
        isMemberish(printedNodes[i + 1].node)
      ) {
        currentGroup.push(printedNodes[i]);
      } else {
        break;
      }
    }
  }
  groups.push(currentGroup);
  currentGroup = [];

  // Then, each following group is a sequence of MemberExpression followed by
  // a sequence of CallExpression. To compute it, we keep adding things to the
  // group until we has seen a CallExpression in the past and reach a
  // MemberExpression
  let hasSeenCallExpression = false;
  for (; i < printedNodes.length; ++i) {
    if (hasSeenCallExpression && isMemberish(printedNodes[i].node)) {
      // [0] should be appended at the end of the group instead of the
      // beginning of the next one
      if (
        printedNodes[i].node.computed &&
        isNumericLiteral(printedNodes[i].node.property)
      ) {
        currentGroup.push(printedNodes[i]);
        continue;
      }

      groups.push(currentGroup);
      currentGroup = [];
      hasSeenCallExpression = false;
    }

    if (
      printedNodes[i].node.type === "CallExpression" ||
      printedNodes[i].node.type === "OptionalCallExpression"
    ) {
      hasSeenCallExpression = true;
    }
    currentGroup.push(printedNodes[i]);

    if (
      printedNodes[i].node.comments &&
      printedNodes[i].node.comments.some(comment => comment.trailing)
    ) {
      groups.push(currentGroup);
      currentGroup = [];
      hasSeenCallExpression = false;
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // There are cases like Object.keys(), Observable.of(), _.values() where
  // they are the subject of all the chained calls and therefore should
  // be kept on the same line:
  //
  //   Object.keys(items)
  //     .filter(x => x)
  //     .map(x => x)
  //
  // In order to detect those cases, we use an heuristic: if the first
  // node is an identifier with the name starting with a capital
  // letter or just a sequence of _$. The rationale is that they are
  // likely to be factories.
  function isFactory(name) {
    return /^[A-Z]|^[_$]+$/.test(name);
  }

  // In case the Identifier is shorter than tab width, we can keep the
  // first call in a single line, if it's an ExpressionStatement.
  //
  //   d3.scaleLinear()
  //     .domain([0, 100])
  //     .range([0, width]);
  //
  function isShort(name) {
    return name.length <= options.tabWidth;
  }

  function shouldNotWrap(groups) {
    const parent = path.getParentNode();
    const isExpression = parent && parent.type === "ExpressionStatement";
    const hasComputed = groups[1].length && groups[1][0].node.computed;

    if (groups[0].length === 1) {
      const firstNode = groups[0][0].node;
      return (
        firstNode.type === "ThisExpression" ||
        (firstNode.type === "Identifier" &&
          (isFactory(firstNode.name) ||
            (isExpression && isShort(firstNode.name)) ||
            hasComputed))
      );
    }

    const lastNode = getLast(groups[0]).node;
    return (
      (lastNode.type === "MemberExpression" ||
        lastNode.type === "OptionalMemberExpression") &&
      lastNode.property.type === "Identifier" &&
      (isFactory(lastNode.property.name) || hasComputed)
    );
  }

  const shouldMerge =
    groups.length >= 2 && !groups[1][0].node.comments && shouldNotWrap(groups);

  function printGroup(printedGroup) {
    const printed = printedGroup.map(tuple => tuple.printed);
    // Checks if the last node (i.e. the parent node) needs parens and print
    // accordingly
    if (
      printedGroup.length > 0 &&
      printedGroup[printedGroup.length - 1].needsParens
    ) {
      return concat(["(", ...printed, ")"]);
    }
    return concat(printed);
  }

  function printIndentedGroup(groups) {
    if (groups.length === 0) {
      return "";
    }
    return indent(
      group(concat([hardline, join(hardline, groups.map(printGroup))]))
    );
  }

  const printedGroups = groups.map(printGroup);
  const oneLine = concat(printedGroups);

  const cutoff = shouldMerge ? 3 : 2;
  const flatGroups = groups
    .slice(0, cutoff)
    .reduce((res, group) => res.concat(group), []);

  const hasComment =
    flatGroups.slice(1, -1).some(node => hasLeadingComment(node.node)) ||
    flatGroups.slice(0, -1).some(node => hasTrailingComment(node.node)) ||
    (groups[cutoff] && hasLeadingComment(groups[cutoff][0].node));

  // If we only have a single `.`, we shouldn't do anything fancy and just
  // render everything concatenated together.
  if (groups.length <= cutoff && !hasComment) {
    return group(oneLine);
  }

  // Find out the last node in the first group and check if it has an
  // empty line after
  const lastNodeBeforeIndent = getLast(
    shouldMerge ? groups.slice(1, 2)[0] : groups[0]
  ).node;
  const shouldHaveEmptyLineBeforeIndent =
    lastNodeBeforeIndent.type !== "CallExpression" &&
    lastNodeBeforeIndent.type !== "OptionalCallExpression" &&
    shouldInsertEmptyLineAfter(lastNodeBeforeIndent);

  const expanded = concat([
    printGroup(groups[0]),
    shouldMerge ? concat(groups.slice(1, 2).map(printGroup)) : "",
    shouldHaveEmptyLineBeforeIndent ? hardline : "",
    printIndentedGroup(groups.slice(shouldMerge ? 2 : 1))
  ]);

  const callExpressions = printedNodes
    .map(({ node }) => node)
    .filter(isCallOrOptionalCallExpression);

  // We don't want to print in one line if there's:
  //  * A comment.
  //  * 3 or more chained calls.
  //  * Any group but the last one has a hard line.
  // If the last group is a function it's okay to inline if it fits.
  if (
    hasComment ||
    callExpressions.length >= 3 ||
    printedGroups.slice(0, -1).some(willBreak) ||
    /**
     *     scopes.filter(scope => scope.value !== '').map((scope, i) => {
     *       // multi line content
     *     })
     */
    (((lastGroupDoc, lastGroupNode) =>
      isCallOrOptionalCallExpression(lastGroupNode) && willBreak(lastGroupDoc))(
      getLast(printedGroups),
      getLast(getLast(groups)).node
    ) &&
      callExpressions
        .slice(0, -1)
        .some(n => n.arguments.some(isFunctionOrArrowExpression)))
  ) {
    return group(expanded);
  }

  return concat([
    // We only need to check `oneLine` because if `expanded` is chosen
    // that means that the parent group has already been broken
    // naturally
    willBreak(oneLine) || shouldHaveEmptyLineBeforeIndent ? breakParent : "",
    conditionalGroup([oneLine, expanded])
  ]);
}

function printArgumentsList(path, options, print) {
  const node = path.getValue();
  const args = node.arguments;

  if (args.length === 0) {
    return concat([
      "(",
      comments.printDanglingComments(path, options, /* sameIndent */ true),
      ")"
    ]);
  }

  // useEffect(() => { ... }, [foo, bar, baz])
  if (
    args.length === 2 &&
    args[0].type === "ArrowFunctionExpression" &&
    args[0].params.length === 0 &&
    args[0].body.type === "BlockStatement" &&
    args[1].type === "ArrayExpression" &&
    !args.find(arg => arg.leadingComments || arg.trailingComments)
  ) {
    return concat([
      "(",
      path.call(print, "arguments", 0),
      ", ",
      path.call(print, "arguments", 1),
      ")"
    ]);
  }

  let anyArgEmptyLine = false;
  let hasEmptyLineFollowingFirstArg = false;
  const lastArgIndex = args.length - 1;
  const printedArguments = path.map((argPath, index) => {
    const arg = argPath.getNode();
    const parts = [print(argPath)];

    if (index === lastArgIndex) {
      // do nothing
    } else if (isNextLineEmpty(options.originalText, arg, options)) {
      if (index === 0) {
        hasEmptyLineFollowingFirstArg = true;
      }

      anyArgEmptyLine = true;
      parts.push(",", hardline, hardline);
    } else {
      parts.push(",", line);
    }

    return concat(parts);
  }, "arguments");

  const maybeTrailingComma =
    // Dynamic imports cannot have trailing commas
    !(node.callee && node.callee.type === "Import") &&
    shouldPrintComma(options, "all")
      ? ","
      : "";

  function allArgsBrokenOut() {
    return group(
      concat([
        "(",
        indent(concat([line, concat(printedArguments)])),
        maybeTrailingComma,
        line,
        ")"
      ]),
      { shouldBreak: true }
    );
  }

  // We want to get
  //    pipe(
  //      x => x + 1,
  //      x => x - 1
  //    )
  // here, but not
  //    process.stdout.pipe(socket)
  if (isFunctionCompositionFunction(node.callee) && args.length > 1) {
    return allArgsBrokenOut();
  }

  const shouldGroupFirst = shouldGroupFirstArg(args);
  const shouldGroupLast = shouldGroupLastArg(args);
  if (shouldGroupFirst || shouldGroupLast) {
    const shouldBreak =
      (shouldGroupFirst
        ? printedArguments.slice(1).some(willBreak)
        : printedArguments.slice(0, -1).some(willBreak)) || anyArgEmptyLine;

    // We want to print the last argument with a special flag
    let printedExpanded;
    let i = 0;
    path.each(argPath => {
      if (shouldGroupFirst && i === 0) {
        printedExpanded = [
          concat([
            argPath.call(p => print(p, { expandFirstArg: true })),
            printedArguments.length > 1 ? "," : "",
            hasEmptyLineFollowingFirstArg ? hardline : line,
            hasEmptyLineFollowingFirstArg ? hardline : ""
          ])
        ].concat(printedArguments.slice(1));
      }
      if (shouldGroupLast && i === args.length - 1) {
        printedExpanded = printedArguments
          .slice(0, -1)
          .concat(argPath.call(p => print(p, { expandLastArg: true })));
      }
      i++;
    }, "arguments");

    const somePrintedArgumentsWillBreak = printedArguments.some(willBreak);

    return concat([
      somePrintedArgumentsWillBreak ? breakParent : "",
      conditionalGroup(
        [
          concat([
            ifBreak(
              indent(concat(["(", softline, concat(printedExpanded)])),
              concat(["(", concat(printedExpanded)])
            ),
            somePrintedArgumentsWillBreak
              ? concat([ifBreak(maybeTrailingComma), softline])
              : "",
            ")"
          ]),
          shouldGroupFirst
            ? concat([
                "(",
                group(printedExpanded[0], { shouldBreak: true }),
                concat(printedExpanded.slice(1)),
                ")"
              ])
            : concat([
                "(",
                concat(printedArguments.slice(0, -1)),
                group(getLast(printedExpanded), {
                  shouldBreak: true
                }),
                ")"
              ]),
          allArgsBrokenOut()
        ],
        { shouldBreak }
      )
    ]);
  }

  return group(
    concat([
      "(",
      indent(concat([softline, concat(printedArguments)])),
      ifBreak(maybeTrailingComma),
      softline,
      ")"
    ]),
    { shouldBreak: printedArguments.some(willBreak) || anyArgEmptyLine }
  );
}

function templateLiteralHasNewLines(template) {
  return template.quasis.some(quasi => quasi.value.raw.includes("\n"));
}

function isUnitTestSetUp(n) {
  const unitTestSetUpRe = /^(before|after)(Each|All)$/;
  return (
    n.callee.type === "Identifier" &&
    unitTestSetUpRe.test(n.callee.name) &&
    n.arguments.length === 1
  );
}

function isSkipOrOnlyBlock(node) {
  return (
    (node.callee.type === "MemberExpression" ||
      node.callee.type === "OptionalMemberExpression") &&
    node.callee.object.type === "Identifier" &&
    node.callee.property.type === "Identifier" &&
    unitTestRe.test(node.callee.object.name) &&
    (node.callee.property.name === "only" ||
      node.callee.property.name === "skip")
  );
}

function isTemplateLiteral(node) {
  return node.type === "TemplateLiteral";
}

function isNumericLiteral(node) {
  return (
    node.type === "NumericLiteral" ||
    (node.type === "Literal" && typeof node.value === "number")
  );
}

function isFunctionOrArrowExpression(node) {
  return (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isFunctionOrArrowExpressionWithBody(node) {
  return (
    node.type === "FunctionExpression" ||
    (node.type === "ArrowFunctionExpression" &&
      node.body.type === "BlockStatement")
  );
}

function printMemberLookup(path, options, print) {
  const property = path.call(print, "property");
  const n = path.getValue();
  const optional = printOptionalToken(path);

  if (!n.computed) {
    return concat([optional, ".", property]);
  }

  if (!n.property || isNumericLiteral(n.property)) {
    return concat([optional, "[", property, "]"]);
  }

  return group(
    concat([optional, "[", indent(concat([softline, property])), softline, "]"])
  );
}

function printBindExpressionCallee(path, options, print) {
  return concat(["::", path.call(print, "callee")]);
}

function hasLeadingComment(node) {
  return node.comments && node.comments.some(comment => comment.leading);
}

function isCallOrOptionalCallExpression(node) {
  return (
    node.type === "CallExpression" || node.type === "OptionalCallExpression"
  );
}

const functionCompositionFunctionNames = new Set([
  "pipe", // RxJS, Ramda
  "pipeP", // Ramda
  "pipeK", // Ramda
  "compose", // Ramda, Redux
  "composeFlipped", // Not from any library, but common in Haskell, so supported
  "composeP", // Ramda
  "composeK", // Ramda
  "flow", // Lodash
  "flowRight", // Lodash
  "connect", // Redux
  "createSelector" // Reselect
]);
const ordinaryMethodNames = new Set([
  "connect" // GObject, MongoDB
]);

function isFunctionCompositionFunction(node) {
  switch (node.type) {
    case "OptionalMemberExpression":
    case "MemberExpression": {
      return (
        isFunctionCompositionFunction(node.property) &&
        !ordinaryMethodNames.has(node.property.name)
      );
    }
    case "Identifier": {
      return functionCompositionFunctionNames.has(node.name);
    }
    case "StringLiteral":
    case "Literal": {
      return functionCompositionFunctionNames.has(node.value);
    }
  }
}

function couldGroupArg(arg) {
  return (
    (arg.type === "ObjectExpression" &&
      (arg.properties.length > 0 || arg.comments)) ||
    (arg.type === "ArrayExpression" &&
      (arg.elements.length > 0 || arg.comments)) ||
    arg.type === "TSTypeAssertion" ||
    arg.type === "TSAsExpression" ||
    arg.type === "FunctionExpression" ||
    (arg.type === "ArrowFunctionExpression" &&
      !arg.returnType &&
      (arg.body.type === "BlockStatement" ||
        arg.body.type === "ArrowFunctionExpression" ||
        arg.body.type === "ObjectExpression" ||
        arg.body.type === "ArrayExpression" ||
        arg.body.type === "CallExpression" ||
        arg.body.type === "OptionalCallExpression" ||
        arg.body.type === "ConditionalExpression" ||
        isJSXNode(arg.body)))
  );
}

function shouldGroupFirstArg(args) {
  if (args.length !== 2) {
    return false;
  }

  const firstArg = args[0];
  const secondArg = args[1];
  return (
    (!firstArg.comments || !firstArg.comments.length) &&
    (firstArg.type === "FunctionExpression" ||
      (firstArg.type === "ArrowFunctionExpression" &&
        firstArg.body.type === "BlockStatement")) &&
    secondArg.type !== "FunctionExpression" &&
    secondArg.type !== "ArrowFunctionExpression" &&
    secondArg.type !== "ConditionalExpression" &&
    !couldGroupArg(secondArg)
  );
}

function shouldGroupLastArg(args) {
  const lastArg = getLast(args);
  const penultimateArg = getPenultimate(args);
  return (
    !hasLeadingComment(lastArg) &&
    !hasTrailingComment(lastArg) &&
    couldGroupArg(lastArg) &&
    // If the last two arguments are of the same type,
    // disable last element expansion.
    (!penultimateArg || penultimateArg.type !== lastArg.type)
  );
}

function printStatementSequence(path, options, print) {
  const printed = [];

  const bodyNode = path.getNode();
  const isClass = bodyNode.type === "ClassBody";

  path.map((stmtPath, i) => {
    const stmt = stmtPath.getValue();

    // Just in case the AST has been modified to contain falsy
    // "statements," it's safer simply to skip them.
    /* istanbul ignore if */
    if (!stmt) {
      return;
    }

    // Skip printing EmptyStatement nodes to avoid leaving stray
    // semicolons lying around.
    if (stmt.type === "EmptyStatement") {
      return;
    }

    const stmtPrinted = print(stmtPath);
    const text = options.originalText;
    const parts = [];

    // in no-semi mode, prepend statement with semicolon if it might break ASI
    // don't prepend the only JSX element in a program with semicolon
    if (
      !options.semi &&
      !isClass &&
      !isTheOnlyJSXElementInMarkdown(options, stmtPath) &&
      stmtNeedsASIProtection(stmtPath, options)
    ) {
      if (stmt.comments && stmt.comments.some(comment => comment.leading)) {
        parts.push(print(stmtPath, { needsSemi: true }));
      } else {
        parts.push(";", stmtPrinted);
      }
    } else {
      parts.push(stmtPrinted);
    }

    if (!options.semi && isClass) {
      if (classPropMayCauseASIProblems(stmtPath)) {
        parts.push(";");
      } else if (stmt.type === "ClassProperty") {
        const nextChild = bodyNode.body[i + 1];
        if (classChildNeedsASIProtection(nextChild)) {
          parts.push(";");
        }
      }
    }

    if (isNextLineEmpty(text, stmt, options) && !isLastStatement(stmtPath)) {
      parts.push(hardline);
    }

    printed.push(concat(parts));
  });

  return join(hardline, printed);
}

function stmtNeedsASIProtection(path, options) {
  const node = path.getNode();

  if (node.type !== "ExpressionStatement") {
    return false;
  }

  return path.call(
    childPath => exprNeedsASIProtection(childPath, options),
    "expression"
  );
}

function classPropMayCauseASIProblems(path) {
  const node = path.getNode();

  if (node.type !== "ClassProperty") {
    return false;
  }

  const name = node.key && node.key.name;

  // this isn't actually possible yet with most parsers available today
  // so isn't properly tested yet.
  if (
    (name === "static" || name === "get" || name === "set") &&
    !node.value &&
    !node.typeAnnotation
  ) {
    return true;
  }
}

function classChildNeedsASIProtection(node) {
  if (!node) {
    return;
  }

  if (
    node.static ||
    node.accessibility // TypeScript
  ) {
    return false;
  }

  if (!node.computed) {
    const name = node.key && node.key.name;
    if (name === "in" || name === "instanceof") {
      return true;
    }
  }
  switch (node.type) {
    case "ClassProperty":
    case "TSAbstractClassProperty":
      return node.computed;
    case "MethodDefinition": // Flow
    case "TSAbstractMethodDefinition": // TypeScript
    case "ClassMethod":
    case "ClassPrivateMethod": {
      // Babel
      const isAsync = node.value ? node.value.async : node.async;
      const isGenerator = node.value ? node.value.generator : node.generator;
      if (isAsync || node.kind === "get" || node.kind === "set") {
        return false;
      }
      if (node.computed || isGenerator) {
        return true;
      }
      return false;
    }

    default:
      /* istanbul ignore next */
      return false;
  }
}

function isLastStatement(path) {
  const parent = path.getParentNode();
  if (!parent) {
    return true;
  }
  const node = path.getValue();
  const body = (parent.body || parent.consequent).filter(
    stmt => stmt.type !== "EmptyStatement"
  );
  return body && body[body.length - 1] === node;
}

function exprNeedsASIProtection(path, options) {
  const node = path.getValue();

  const maybeASIProblem =
    pathNeedsParens(path, options) ||
    node.type === "ParenthesizedExpression" ||
    node.type === "TypeCastExpression" ||
    (node.type === "ArrowFunctionExpression" &&
      !shouldPrintParamsWithoutParens(path, options)) ||
    node.type === "ArrayExpression" ||
    node.type === "ArrayPattern" ||
    (node.type === "UnaryExpression" &&
      node.prefix &&
      (node.operator === "+" || node.operator === "-")) ||
    node.type === "TemplateLiteral" ||
    node.type === "TemplateElement" ||
    isJSXNode(node) ||
    (node.type === "BindExpression" && !node.object) ||
    node.type === "RegExpLiteral" ||
    (node.type === "Literal" && node.pattern) ||
    (node.type === "Literal" && node.regex);

  if (maybeASIProblem) {
    return true;
  }

  if (!hasNakedLeftSide(node)) {
    return false;
  }

  return path.call.apply(
    path,
    [childPath => exprNeedsASIProtection(childPath, options)].concat(
      getLeftSidePathName(path, node)
    )
  );
}

function hasNakedLeftSide(node) {
  return (
    node.type === "AssignmentExpression" ||
    node.type === "BinaryExpression" ||
    node.type === "LogicalExpression" ||
    node.type === "NGPipeExpression" ||
    node.type === "ConditionalExpression" ||
    node.type === "CallExpression" ||
    node.type === "OptionalCallExpression" ||
    node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression" ||
    node.type === "SequenceExpression" ||
    node.type === "TaggedTemplateExpression" ||
    node.type === "BindExpression" ||
    (node.type === "UpdateExpression" && !node.prefix) ||
    node.type === "TSNonNullExpression"
  );
}

function shouldPrintParamsWithoutParens(path, options) {
  if (options.arrowParens === "always") {
    return false;
  }

  if (options.arrowParens === "avoid") {
    const node = path.getValue();
    return canPrintParamsWithoutParens(node);
  }

  // Fallback default; should be unreachable
  return false;
}

function getLeftSidePathName(path, node) {
  if (node.expressions) {
    return ["expressions", 0];
  }
  if (node.left) {
    return ["left"];
  }
  if (node.test) {
    return ["test"];
  }
  if (node.object) {
    return ["object"];
  }
  if (node.callee) {
    return ["callee"];
  }
  if (node.tag) {
    return ["tag"];
  }
  if (node.argument) {
    return ["argument"];
  }
  if (node.expression) {
    return ["expression"];
  }
  throw new Error("Unexpected node has no left side", node);
}

function canPrintParamsWithoutParens(node) {
  return (
    node.params.length === 1 &&
    !node.rest &&
    !node.typeParameters &&
    !hasDanglingComments(node) &&
    node.params[0].type === "Identifier" &&
    !node.params[0].typeAnnotation &&
    !node.params[0].comments &&
    !node.params[0].optional &&
    !node.predicate &&
    !node.returnType
  );
}

module.exports = {
  print: genericPrint,
  embed,
  insertPragma,
  massageAstNode: clean,
  hasPrettierIgnore,
  willPrintOwnComments,
  canAttachComment,
  printComment,
  isBlockComment: handleComments.isBlockComment,
  handleComments: {
    ownLine: handleComments.handleOwnLineComment,
    endOfLine: handleComments.handleEndOfLineComment,
    remaining: handleComments.handleRemainingComment
  }
};
