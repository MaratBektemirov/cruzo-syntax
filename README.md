# Cruzo Syntax (VS Code)

Syntax highlighting and formatting for Cruzo templates in TypeScript `getHTML()` template literals.

## What is supported

- Cruzo template expressions: `{{ ... }}`
- Reactive operators and keywords: `::rx`, `once::`
- Special template attributes: `repeat`, `attached`, `inner-html`, `let-*`
- Event attributes: `on*` (for example `onclick`)
- Highlighting in `.ts/.js` template literals (typical `getHTML()`)
- Command-based formatter for all template literals in current file
- Command-based formatter for all template literals in workspace (`.ts`/`.js`)

## File types

TypeScript/JavaScript only. The extension injects Cruzo highlighting into template literals returned from code (for example in `getHTML()`).

## Formatter behavior

Formatter does:

- HTML-like indentation
- Normalization of expression braces (`{{ expr }}`)
- Wraps expression-only special attributes to mustache form (`repeat`, `attached`, `inner-html`, `let-*`, `on*`)
- Respects configurable indentation size (`cruzo.format.indentSize`)

In TypeScript/JavaScript files:

- run command **Cruzo: Format Templates In Current File**
- or run **Cruzo: Format Templates In Workspace**

## Development

1. Open this project in VS Code.
2. Press `F5` to run Extension Development Host.
3. Open a `.ts` file with `getHTML() { return \`...\`; }`.
4. Check highlighting inside the template literal.
5. Run **Cruzo: Format Templates In Current File**.

## Notes

This is a lightweight first version focused on Cruzo template syntax.
