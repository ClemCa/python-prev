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
let sourceMap = new Map<number, number>();

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
        let isError = state[i].startsWith('Error: ');
        let mappedLine = sourceMap.get(i) ?? i;
        let isCurrent = currentCursorLine === mappedLine;
        let stateLine = state[i].substring(state[i].indexOf(':')+1).trim();
        if(stateLine === '') continue;
        console.log("mapped line", mappedLine, "stateline:", stateLine,"from", state[i]);
        displayInline(mappedLine, stateLine, isError ? isCurrent ? DecorationMode.activeError : DecorationMode.error : isCurrent ? DecorationMode.active : DecorationMode.regular, decorations);
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
    setKeysFromCode(sourceMap, pythonCode);
    console.log("generated python code", pythonCode, "with source map", sourceMap);
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
            let match = dataString.match(/line (\d+)/g);
            line = match?.[match.length - 1].split(' ')[1];
            line = (sourceMap.get(parseInt(line)) ?? (line+1)) - 1;
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
    output = Fuse(output);
    console.log("Fused", output);
    setKeysFromOutput(sourceMap, output);
    return output;
    // return output.map(r => r.slice(r.indexOf(':')+1).trim());
}

function Deduplicate(output: string[]) { // we keep the original order
    return output.reduce((acc, cur) => {
        if(acc.includes(cur)) return acc;
        acc.push(cur);
        return acc;
    }, [] as string[]);
}

function Fuse(output: string[]) { // fuse, vscode forces our hand as the order of decorations is consistent but not guaranteed to be in the order of the array
    console.log("raw output", output);
    output = Deduplicate(output);
    let fused = [] as string[];
    let highestValue = 0;
    for(let i = 0; i < output.length; i++)
    {
        let line = parseInt(output[i].split(':')[0]);
        if(line > highestValue) highestValue = line;
    }
    for(let i = 0; i <= highestValue; i++) // couldn't bring myself to make it O(n^2), so we're removing elements from the array.
    {                                           // In theory we have a diminishing number of elements to check in the inner loop.
        for(let j = 0; j < output.length; j++)
        {
            if(output[j].startsWith(i+':'))
            {
                if(fused[i] === undefined || fused[i] === '') fused[i] = i + ':';
                fused[i] = ((fused[i] ?? '') + '  ' + splitUpTo(output[j], ':',1)[1]).trim();
                output.splice(j, 1);
                j--;
            }
        }
    }
    return fused.filter(v => v !== undefined && v !== '' && splitUpTo(v, ':', 1)[1].trim() !== '');
}

function splitUpTo(s: string, separator: string, limit: number) {
    let result = [] as string[];
    let left = 0;
    while(limit--) {
        let next = s.indexOf(separator);
        if(next === -1) {
            break;
        }
        result.push(s.slice(left, next));
        left = next + separator.length;
    }
    result.push(s.slice(left));
    console.log("splitUpTo", s, separator, limit, result);
    return result;
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

function setKeysFromCode(map: Map<number, number>, code: string) {
    map.clear();
    let lines = code.split(/\r?\n/);
    for(let i = 0, last = 1; i < lines.length; i++)
    {
        let line = lines[i];
        if(line.trim().startsWith("print"))
        {
            line = line.split(':')[0];
            let lineNum = parseInt(line.slice(line.indexOf('"') + 1)) + 1;
            map.set(i, lineNum);
            last = lineNum;
        } else {
            map.set(i, last);
        }
    }
}
function setKeysFromOutput(map: Map<number, number>, output: string[]) {
    map.clear();
    for(let i = 0; i < output.length; i++)
    {
        if(!output[i].match(/^\d+:/)) continue;
        let line = parseInt(output[i].split(':')[0]);
        map.set(i, line);
    }
}
function GeneratePython(lines: string[], lineI: number, indentation: number = 0): string {
    if (lineI >= lines.length) return '';
    let line = lines[lineI];
    let continueLine = lineI;
    let additionalLines = '';
    let returnPreviously = line.trim().startsWith('return');
    while(lines[continueLine].trim().split('#')[0].endsWith('\\')) { // all comments besides the first one are ignored
        let preComment = line.split('#')[0].split('\\')[0];
        let postComment = line.split('#')[1];
        line = preComment + lines[++continueLine].trim().split('#')[0].split('\\')[0];
        if(postComment) line += '#' + postComment;
        if(returnPreviously) line = ' '.repeat(indentation) + `print("${continueLine}:")\n` + line;
        else additionalLines += 'print("' + continueLine + ':")\n';
    }
    continueLine++;
    if (line.trim() === '') {
        return ' '.repeat(indentation) + `print("${lineI}:")\n` + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation);
    }
    if(line.match(/^\s*(?:elif|else)/))
    {
        return line + '\n' + ' '.repeat(indentation) + `print("${lineI}:")\n` + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation);
    }
    let checkLine = line + '';
    line = mockInput(line, indentation, lineI, lines);
    if(checkLine.trimStart().startsWith("def") && line.length > checkLine.length) {
        console.log("mocked def", line);
        let endOfDef = continueLine;
        while(endOfDef < lines.length && (lines[endOfDef].match(/^\s*/)?.[0].length ?? 0) > indentation) endOfDef++;
        return line + '\n' + GeneratePython(lines, endOfDef, indentation);
    }
    // line starts with assignment
    let assignmentMatch = checkLine.match(/^\s*[a-zA-Z_][a-zA-Z_0-9]*\s*=/);
    if (assignmentMatch) {
        // print the assignment
        indentation = indentationFromLine(checkLine);
        return line + '\n' + ' '.repeat(indentation) + `print("${lineI}: " + str(${assignmentMatch[0].replace(/=/, '').trim()}))\n` + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation);
    }
    let specialAssignmentMatch = checkLine.match(/^\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*([-\+\*\/])=/);
    if(specialAssignmentMatch)
    {
        let variable = specialAssignmentMatch[1];
        let operator = specialAssignmentMatch[2];
        let restOfLine = stripComments(checkLine.split('=')[1]).trim();
        indentation = indentationFromLine(checkLine);
        return ' '.repeat(indentation) + `print("${lineI}: " + str(${variable} ${operator} (${restOfLine})))\n` + line + '\n' + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation);
    }
    // line starts with print and isn't a multiline
    if (checkLine.match(/^\s*print\s*/) && !returnPreviously) {
        let modifiedLine = line.split("#")[0].replace(/print\s*\(/, `print("${lineI}:" + str(`) + ')';
        indentation = indentationFromLine(checkLine);
        return modifiedLine + '\n' + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation);
    }
    // line is a for loop
    if (checkLine.match(/^\s*for/)) {
        indentation = indentationFromLine(checkLine, true);
        let afterIn = checkLine.split('in')[1].split(':')[0].trim();
        return ' '.repeat(indentation) + `print("${lineI}:"+str(${afterIn}))\n` + line + '\n' + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation + indentSize);
    }
    if (checkLine.match(/^\s*return\s+/) || returnPreviously) {
        let nextIndentation = continueLine >= lines.length ? 0 : indentationFromLine(lines[continueLine], true);
        indentation = indentationFromLine(checkLine);
        let afterReturn = checkLine.split('return')[1].trim();
        let beforeReturn = checkLine.split('return')[0]; // there's pregenerated stuff we want to keep
        if(afterReturn.indexOf(' ') !== -1) afterReturn = '(' + afterReturn + ')';
        return beforeReturn + `print("${lineI}:"+str(${afterReturn}))\n` + ' '.repeat(indentation) + 'return ' + afterReturn + '\n' + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, nextIndentation);
    }
    if (checkLine.match(/^\s*def\s*/) && !(checkLine.split('#')[1] ?? "").match(/mock\s?\(/)) {
        indentation = indentationFromLine(checkLine);
        let parameters = checkLine.split('(')[1].split(')')[0].split(',').map(v => v.split('=')[0].trim()).filter(v => v !== '');
        let parameterStrings = parameters.map(v => ' '.repeat(indentation) + `print("${lineI}:${v}: "+str(${v}))`);
        return line + '\n' + parameterStrings.join('\n') + '\n' + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation);
    }
    if (endsWithColon(checkLine)) {
        indentation = indentationFromLine(checkLine, true);
        return ' '.repeat(indentation) + `print("${lineI}:")\n` + line + '\n' + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation + indentSize);
    }
    indentation = indentationFromLine(checkLine);
    return line + '\n' + ' '.repeat(indentation) + `print("${lineI}:")\n` + ' '.repeat(additionalLines.length > 0 ? indentation : 0) + additionalLines + GeneratePython(lines, continueLine, indentation);
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
function mockInput(line: string, indentation: number, lineI: number, lines: string[]) {
    if(!line.match(/\s+input\s*\(/)) return mockOrLimitLine(line, lineI, lines);
    let UUID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let comment = line.split('#')[1]?.trim() ?? '';
    let {mock, limit} = passComments(comment);
    let checkCode = ' '.repeat(indentation) + `if not check_UUID_count('${UUID}', ${limit ?? 100}):\n` + ' '.repeat(indentSize + indentation) + "raise Exception('ClemExcep"+lineI+":Too many calls to input. Use a mock comment if necessary.')\n";
    return checkCode + line.replace(/input\(.*\)/, mock ?? '""');
}

function mockOrLimitLine(line: string, lineI: number, lines: string[]) {
    let comment = line.split('#')[1]?.trim() ?? '';
    let {mock, limit} = passComments(comment);
    if(mock) line = mockLine(line, mock, lineI, lines);
    if(!limit) return line;
    let indentation = indentationFromLine(line, true);
    let UUID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return ' '.repeat(indentation) + `if not check_UUID_count('${UUID}', ${limit}):\n` + ' '.repeat(indentSize + indentation) + "raise Exception('ClemExcep"+lineI+":Too many calls.')\n"+line;
}

function mockLine(line: string, mock: string, lineI: number, lines: string[]) {
    if(line.trim().startsWith('def')) return mockDef(line, mock, lineI, lines);
    if(line.indexOf("=") === -1) return line;
    return line.replace(/=.*$/, `= ${mock}`);
}

function mockDef(line: string, mock: string, lineI: number, lines: string[]) {
    let finalLine = line;
    let GUUID = "mock"+Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let nextLineOfSuperiorIndentation = lineI + 1;
    let copy = line;
    while(nextLineOfSuperiorIndentation < lines.length && ((lines[nextLineOfSuperiorIndentation] ?? "").match(/^\s*/)?.[0].length ?? 0) > indentationFromLine(line, true))
    {
        let startedWithPrint = false;
        copy += '\n' + lines[nextLineOfSuperiorIndentation].replace(/print\((.*)\)/, (match, p1) => {
            startedWithPrint = true;
            return match[0];
        });
        if(startedWithPrint) continue;
        let ran = false;
        while(lines[nextLineOfSuperiorIndentation].split('#')[0].trim().endsWith('\\'))
        {
            copy += '\n' + lines[++nextLineOfSuperiorIndentation].split('#')[0].split('\\')[0].trimEnd();
            ran = true;
        }
        if(ran && startedWithPrint) copy = copy.trimEnd().slice(0, -1); // remove extra parenthesis
        nextLineOfSuperiorIndentation++;
    }
    let trueCopy = lines.slice(0, nextLineOfSuperiorIndentation);
    trueCopy[lineI] = line.split('#')[0].replace(/def\s+([a-zA-Z_][a-zA-Z_0-9]*)/, `def ${GUUID}`);
    // 0 to up to nextLineOfSuperiorIndentation
    let python = GeneratePython(trueCopy, lineI, indentationFromLine(line, true));
    console.log("generated python for def", python, "from", trueCopy);
    finalLine = python + '\n' + ' '.repeat(indentationFromLine(line, true)) + `${GUUID}(${mock})\n` + copy;
    return finalLine;
}

function passComments(comment: string): { limit?: number, mock?: string } {
    if(comment === '') return {};
    if(comment.startsWith('mock (') || comment.startsWith('mock('))
    {
        return { ...passComments(comment.slice(comment.indexOf(')'))), mock: comment.slice(comment.indexOf('(')+1, comment.indexOf(')')) };
    }
    if(comment.startsWith('limit (') || comment.startsWith('limit('))
    {
        return { ...passComments(comment.slice(comment.indexOf(')'))), limit: parseInt(comment.slice(comment.indexOf('(')+1, comment.indexOf(')'))) };
    }
    return {};
}