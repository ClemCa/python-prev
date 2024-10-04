/* eslint-disable curly */
import * as vscode from 'vscode';
import * as child from 'child_process';

let workspaceMemento: Map<string, string[]>

export function activate(context: vscode.ExtensionContext) {
    workspaceMemento = context.workspaceState.get('python-prev') || new Map<string, string[]>();
}

function previewRun(change: vscode.TextDocumentChangeEvent) {
    let fileName = change.document.fileName;
    let state = workspaceMemento.get(fileName) || [];
    let line = change.contentChanges[0].range.start.line;
    let results = runPython(line, change.document.getText());
    state = state.splice(line).concat(results);
    workspaceMemento.set(fileName, state);
}

function runPython(line: number, documentText: string) {
    let lines = documentText.split(/\r?\n/);
    let childProcess = child.spawn('python');
    let results = runLine(lines, line, 0, childProcess);
    // all lines start by line numbers, so the sort is just fine
    results.sort((a, b) => a.localeCompare(b));
    return results.map(r => r.replace(/^\d+:/, ''));
    // TODO: test if it works as expected
}

function runLine(lines: string[], lineI: number, min: number, childProcess: child.ChildProcess, missed = 0): string[] {
    let print = lineI >= min;
    let line = lines[lineI];
    let stdIn = '';
    if (line.trim() === '') {
        stdIn = `print("${line}:")\n`;
    }
    else if (!print) {
        childProcess.stdin?.write(line + '\n');
        stdIn = `print("${line}:")\n`;
    }
    else {
        // line starts with assignment
        let assignmentMatch = line.match(/^\s*[a-zA-Z_][a-zA-Z_0-9]*\s*=/);
        if (assignmentMatch) {
            // print the assignment
            childProcess.stdin?.write(line + '\n');
            stdIn = `print("${line}: " + ${assignmentMatch[0].replace(/=/, '')})\n`;
        }
        // line starts with print
        else if (line.match(/^\s*print\s*\(/)) {
            let modifiedLine = line.replace(/print\s*\(/, `print("${line}:" + `);
            stdIn = modifiedLine + '\n';
        }
        // line is a for loop
        else if (line.match(/^\s*for/)) {
            childProcess.stdin?.write(line + '\n');
            let afterIn = line.split('in')[1].split(':')[0].trim();
            stdIn = `print("${line}:"+${afterIn})\n`;
        }
        else {
            childProcess.stdin?.write(line + '\n');
            stdIn = `print("${line}:")\n`;
        }
    }
    childProcess.stdin?.write(stdIn);
    let stdOut = childProcess.stdout?.read() as Buffer | null;
    let stdLines = stdOut?.toString().split(/\r?\n/) ?? [stdIn];
    if (stdLines[stdLines.length - 1] === stdIn) {
        return runLine(lines, lineI + 1, min, childProcess, missed + 1);
    }
    let slicedStd = stdLines.slice(Math.max(0, stdLines.length - missed - 1));
    return [...slicedStd, ...runLine(lines, lineI + 1, min, childProcess)];
}


export function deactivate() { }
