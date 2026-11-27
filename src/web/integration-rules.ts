// Build entry for the lazy integration rules editor. Keeping Monaco contributions out
// of integrations.js means the editor bundle is fetched only when the panel opens.
import "monaco-editor/basic-languages/monaco.contribution";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/format/browser/formatActions";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/editor/contrib/codelens/browser/codeLensCache";
import "monaco-editor/editor/contrib/codelens/browser/codelensController";
import "monaco-editor/editor/common/services/treeViewsDndService";
import "monaco-editor/editor/browser/coreCommands";

export { createCodePreviewEditor, createIntegrationRulesEditor } from "./integration-rules-editor";
export type { CodePreviewOptions, IntegrationRulesEditor, EditorValidation, RulesFormat, RulesKind } from "./integration-rules-editor";