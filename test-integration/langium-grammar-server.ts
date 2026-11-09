import { createLangiumGrammarServices } from 'langium/grammar';
import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';

// Langium's own grammar language server over stdio, used as a feature-rich
// integration target. node runs this file directly via type stripping.
const connection = createConnection(ProposedFeatures.all);
const { shared } = createLangiumGrammarServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);
