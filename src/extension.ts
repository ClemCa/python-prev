/* eslint-disable curly */
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	vscode.workspace.onDidChangeTextDocument(previewRun);
}

function previewRun(change: vscode.TextDocumentChangeEvent) {
}


export function deactivate() {}