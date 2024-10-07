/* eslint-disable curly */
import * as vscode from 'vscode';
import * as child from 'child_process';

let workspaceMemento: Map<string, string[]>;
let decorationType: vscode.TextEditorDecorationType;
let previewColor: string;
let activeColor: string;
let errorColor: string;
let activeErrorColor: string;
let skipNext = false;
let earliestError = Infinity;
let indentSize = 4;
let sourceMap = new Map();

enum DecorationMode {
    regular,
    active,
    error,
    activeError
}

export function activate(context: vscode.ExtensionContext) {
    workspaceMemento = context.workspaceState.get('python-prev') || new Map<string, string[]>();
    decorationType = vscode.window.createTextEditorDecorationType({
        after : {
            margin: '0 0 0 10px'
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        isWholeLine: true,
    });
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        skipNext = true;
        previewRun(e);
    }));
    // line change
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
        if(skipNext) return skipNext = false;
        if(e.textEditor.document.languageId !== 'python') return;
        previewRun({ document: e.textEditor.document, contentChanges: [] });
    }));
    context.subscriptions.push(vscode.languages.registerHoverProvider('python', {
        async provideHover(document, position, token) {
            let state = workspaceMemento.get(document.fileName) || [];
            let line = position.line;
            if(state.length <= line) return;
            let hoverText = state[line];
            let lineLength = document.lineAt(line).text.length;
            if(position.character < lineLength) return;
            if(position.character > lineLength + hoverText.split('\n')[0].length + 10) return;
            return { contents: [hoverText] };
        }
    }));
    if(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'python')
    {
        previewRun({ document: vscode.window.activeTextEditor.document, contentChanges: [] });
    }
}

export function deactivate(context: vscode.ExtensionContext) {
    workspaceMemento.clear();
    decorationType.dispose();
    context.workspaceState.update('python-prev', undefined);
}

async function previewRun(change: vscode.TextDocumentChangeEvent | { document: vscode.TextDocument, contentChanges: vscode.TextDocumentContentChangeEvent[] }) {
    if (change.document.languageId !== 'python') return; // just in case the type changed midway through
    let fileName = change.document.fileName;
    let state = workspaceMemento.get(fileName) || [];
    if(change.contentChanges.length > 0 || state.length === 0)
    {
        let results = await runPython(change.document.getText());
        indentSize = vscode.workspace.getConfiguration('editor').get('tabSize') as number;
        earliestError = results.findIndex(r => r.startsWith('Error: '));
        if(earliestError === -1) earliestError = Infinity;
        state.splice(0, Infinity, ...results);
        workspaceMemento.set(fileName, state);
    }
    let currentCursorLine = vscode.window.activeTextEditor?.selection.active.line;
    previewColor = vscode.workspace.getConfiguration('python-prev').get('color') as string;
    activeColor = vscode.workspace.getConfiguration('python-prev').get('activeColor') as string;
    errorColor = vscode.workspace.getConfiguration('python-prev').get('error') as string;
    activeErrorColor = vscode.workspace.getConfiguration('python-prev').get('activeError') as string;
    if(!vscode.window.activeTextEditor) return;
    let decorations = [] as vscode.DecorationOptions[];
    for (let i = 0; i < state.length; i++) {
        let mappedLine = sourceMap.get(i) ?? i;
        let isError = state[i].startsWith('Error: ');
        let isCurrent = currentCursorLine === mappedLine;
        displayInline(mappedLine, state[i], isError ? isCurrent ? DecorationMode.activeError : DecorationMode.error : isCurrent ? DecorationMode.active : DecorationMode.regular, decorations);
    }
    vscode.window.activeTextEditor.setDecorations(decorationType, decorations);
}

async function runPython(documentText: string) {
    let lines = documentText.split(/\r?\n/);
    let pythonStarterCode =
`clemca_python_prev_loop_dict = {}
def check_UUID_count(UUID, limit):
    if UUID not in clemca_python_prev_loop_dict:
        clemca_python_prev_loop_dict[UUID] = 1
    else:
        clemca_python_prev_loop_dict[UUID] += 1
    return clemca_python_prev_loop_dict[UUID] <= limit\n`;
    let pythonCode = pythonStarterCode + GeneratePython(lines, 0);
    console.log("generated python code", pythonCode);
    let childProcess = child.spawn('python', ['-c', pythonCode]);
    let output = [] as string[];
    childProcess.stdout.on('data', (data) => {
        output.push(...(data.toString() as string).split(/\r?\n/).map(v => v.trim()).filter(v => v !== ''));
    });
    childProcess.stderr.on('data', (data) => {
        let dataString = data.toString();
        let line = dataString.match(/ClemExcep(\d+):/)?.[1];
        if(line)
        {
            dataString = dataString.replace(/ClemExcep\d+:/, '').replace("Exception: ", "Python Prev:").trim();
        }
        else
        {
            line = dataString.match(/line (\d+)/)?.[1];
            line = (sourceMap.get(line) ?? (line+1)) - 1;
        }
        while (output.length < line) output.push(output.length + ':');
        output.push(line+': Error: ' + dataString.trim());
    });
    await new Promise<void>((resolve) => {
        setTimeout(() => {
            childProcess.kill();
            if(output.length > 0)
            {
                let lastLine = parseInt(output[output.length - 1].split(':')[0]);
                output.push(lastLine + 1 + ':Error: Timeout');
            }
            else {
                output.push('0:Error: Timeout');
            }
            childProcess.stdout.removeAllListeners();
            childProcess.stderr.removeAllListeners();
            childProcess.removeAllListeners();
            resolve();
        }, vscode.workspace.getConfiguration('python-prev').get('timeout') as number);
        childProcess.on('close', () => {
            if(childProcess)
            {
                childProcess.stdout.removeAllListeners();
                childProcess.stderr.removeAllListeners();
                childProcess.removeAllListeners();
            }
            resolve();
        });
    });
    setKeysFromOutput(sourceMap, output);
    return output.map(r => r.slice(r.indexOf(':')+1).trim());

}

function displayInline(line: number, text: string, decorationMode: DecorationMode, decorationArray: vscode.DecorationOptions[] = []) {
    let editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if(editor.document.lineCount <= line)
    {
        console.error("Line number out of range ("+line+": "+text+"), setting to last line");
        line = editor.document.lineCount - 1;
    }
    let range = editor.document.lineAt(line).range;
    let color: string;
    switch(decorationMode) {
        case DecorationMode.regular:
            color = previewColor;
            break;
        case DecorationMode.active:
            color = activeColor;
            break;
        case DecorationMode.error:
            color = errorColor;
            break;
        case DecorationMode.activeError:
            color = activeErrorColor;
            break;
    };
    console.log("Displaying", line, text, color);
    let lines = text.split(/\r?\n/);
    let decoration = { range, renderOptions: { after: { contentText: lines[lines.length - 1], color: color } } };
    // is there already an identical decoration?
    if(decorationArray.some(d => d.range.isEqual(range) && d.renderOptions?.after?.contentText === lines[lines.length - 1])) return;
    decorationArray.push(decoration);

}

function setKeysFromOutput(map: Map<number, number>, output: string[]) {
    for(let i = 0; i < output.length; i++)
    {
        let line = parseInt(output[i].split(':')[0]);
        map.set(i, line);
    }
}
function GeneratePython(lines: string[], lineI: number, indentation: number = 0): string {
    if (lineI >= lines.length) return '';
    let line = lines[lineI];
    if (line.trim() === '') {
        return ' '.repeat(indentation) + `print("${lineI}:")\n` + GeneratePython(lines, lineI + 1, indentation);
    }
    if(line.match(/^\s*(?:elif|else)/))
    {
        return line + '\n' + ' '.repeat(indentation + indentSize) + `print("${lineI}:")\n` + GeneratePython(lines, lineI + 1, indentation + (line.trim().endsWith(':') ? indentSize : 0));
    }
    let checkLine = line;
    line = mockInput(line, indentation, lineI);
    // line starts with assignment
    let assignmentMatch = checkLine.match(/^\s*[a-zA-Z_][a-zA-Z_0-9]*\s*=/);
    if (assignmentMatch) {
        // print the assignment
        indentation = indentationFromLine(checkLine);
        return line + '\n' + ' '.repeat(indentation) + `print("${lineI}: " + str(${assignmentMatch[0].replace(/=/, '').trim()}))\n` + GeneratePython(lines, lineI + 1, indentation);
    }
    let specialAssignmentMatch = checkLine.match(/^\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*([-\+\*\/])=/);
    if(specialAssignmentMatch)
    {
        let variable = specialAssignmentMatch[1];
        let operator = specialAssignmentMatch[2];
        let restOfLine = stripComments(checkLine.split('=')[1]).trim();
        indentation = indentationFromLine(checkLine);
        return ' '.repeat(indentation) + `print("${lineI}: " + str(${variable} ${operator} (${restOfLine})))\n` + line + '\n' + GeneratePython(lines, lineI + 1, indentation);
    }
    // line starts with print
    if (checkLine.match(/^\s*print\s*\(/)) {
        let modifiedLine = line.split("#")[0].replace(/print\s*\(/, `print("${lineI}:" + str(`) + ')';
        indentation = indentationFromLine(checkLine);
        return modifiedLine + '\n' + GeneratePython(lines, lineI + 1, indentation);
    }
    // line is a for loop
    if (checkLine.match(/^\s*for/)) {
        indentation = indentationFromLine(checkLine, true);
        let afterIn = checkLine.split('in')[1].split(':')[0].trim();
        return ' '.repeat(indentation) + `print("${lineI}:"+str(${afterIn}))\n` + line + '\n' + GeneratePython(lines, lineI + 1, indentation + indentSize);
    }
    if (checkLine.match(/^\s*return\s*/)) {
        let nextIndentation = indentationFromLine(lines[lineI + 1], true);
        indentation = indentationFromLine(checkLine);
        let afterReturn = checkLine.split('return')[1].trim();
        if(afterReturn.indexOf(' ') !== -1) afterReturn = '(' + afterReturn + ')';
        return ' '.repeat(indentation) + `print("${lineI}:"+str(${afterReturn}))\n` + line + '\n' + GeneratePython(lines, lineI + 1, nextIndentation);
    }
    if (checkLine.match(/^\s*def\s*/)) {
        indentation = indentationFromLine(checkLine);
        let parameters = checkLine.split('(')[1].split(')')[0].split(',').map(v => v.split('=')[0].trim()).filter(v => v !== '');
        let parameterStrings = parameters.map(v => ' '.repeat(indentation) + `print("${lineI}:${v}: "+str(${v}))`);
        return line + '\n' + parameterStrings.join('\n') + '\n' + GeneratePython(lines, lineI + 1, indentation);
    }
    if (endsWithColon(checkLine)) {
        indentation = indentationFromLine(checkLine, true);
        return ' '.repeat(indentation) + `print("${lineI}:")\n` + line + '\n' + GeneratePython(lines, lineI + 1, indentation + indentSize);
    }
    indentation = indentationFromLine(checkLine);
    return line + '\n' + ' '.repeat(indentation) + `print("${lineI}:")\n` + GeneratePython(lines, lineI + 1, indentation);
}
function stripComments(line: string) {
    return line.split('#')[0];
}
function indentationFromLine(line: string, ignoreColon: boolean = false) {
    return (line.match(/^\s*/)?.[0].length ?? 0) + (ignoreColon === false && endsWithColon(line) ? indentSize : 0);
}
function endsWithColon(line: string) {
    return stripComments(line).trimEnd().endsWith(':');
}
function mockInput(line: string, indentation: number, lineI: number) {
    if(!line.match(/\s+input\s*\(/)) return limitLine(line, lineI);
    let UUID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let comment = line.split('#')[1]?.trim() ?? '';
    let {mock, limit} = passComments(comment);
    let checkCode = ' '.repeat(indentation) + `if not check_UUID_count('${UUID}', ${limit ?? 100}):\n` + ' '.repeat(indentSize + indentation) + "raise Exception('ClemExcep"+lineI+":Too many calls to input. Use a mock comment if necessary.')\n";
    return checkCode + line.replace(/input\(.*\)/, mock ?? "");
}

function limitLine(line: string, lineI: number) {
    let comment = line.split('#')[1]?.trim() ?? '';
    let {limit} = passComments(comment);
    if(!limit) return line;
    console.log("limiting to ", limit);
    let indentation = indentationFromLine(line, true);
    let UUID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return ' '.repeat(indentation) + `if not check_UUID_count('${UUID}', ${limit}):\n` + ' '.repeat(indentSize + indentation) + "raise Exception('ClemExcep"+lineI+":Too many calls.')\n"+line;
}

function passComments(comment: string): { limit?: number, mock?: string } {
    if(comment === '') return {};
    if(comment.startsWith('mock (') || comment.startsWith('mock('))
    {
        return { ...passComments(comment.slice(comment.indexOf(')'))), mock: comment.slice(comment.indexOf('(')+1, comment.indexOf(')')) };
    }
    if(comment.startsWith('limit (') || comment.startsWith('limit('))
    {
        console.log("found limit of ", comment.slice(comment.indexOf('(')+1, comment.indexOf(')')));
        return { ...passComments(comment.slice(comment.indexOf(')'))), limit: parseInt(comment.slice(comment.indexOf('(')+1, comment.indexOf(')'))) };
    }
    return {};
}