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

let cancelTokens: Map<string, vscode.CancellationTokenSource> = new Map<string, vscode.CancellationTokenSource>();

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
            const line = state.findIndex(v => v.startsWith(position.line + ':'));
            if(line === -1) return;
            let hoverText = state[line].substring(state[line].indexOf(':')+1).trim();
            let lineLength = document.lineAt(line).text.length;
            if(position.character < lineLength) return;
            if(position.character > lineLength + hoverText.split('\n')[0].length + 10) return;
            return { contents: hoverText.split('\n') };
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
    if(cancelTokens.has(fileName)) cancelTokens.get(fileName)?.cancel();
    let cancelToken = new vscode.CancellationTokenSource();
    cancelTokens.set(fileName, cancelToken);
    let state = workspaceMemento.get(fileName) || [];
    if(change.contentChanges.length > 0 || state.length === 0)
    {
        let results = await runPython(change.document.getText(), cancelToken.token);
        if(cancelToken.token.isCancellationRequested) {
            cancelToken.dispose(); // will be replaced by the next run, no need to delete it from the map
        }
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
        stateLine = stateLine.replaceAll('\n', '\\n');
        console.log("mapped line", mappedLine, "stateline:", stateLine,"from", state[i]);
        displayInline(mappedLine, stateLine, isError ? isCurrent ? DecorationMode.activeError : DecorationMode.error : isCurrent ? DecorationMode.active : DecorationMode.regular, decorations);
    }
    vscode.window.activeTextEditor.setDecorations(decorationType, decorations);
    cancelToken.dispose();
    cancelTokens.delete(fileName);
}

async function runPython(documentText: string, cancelToken: vscode.CancellationToken) {
    let lines = documentText.split(/\r?\n/);
    let pythonStarterCode =
`clemca_python_prev_loop_dict = {}
clemca_never_run_dict = {}
def clemca_check_UUID_count(UUID, limit):
    if UUID not in clemca_python_prev_loop_dict:
        clemca_python_prev_loop_dict[UUID] = 1
    else:
        clemca_python_prev_loop_dict[UUID] += 1
    return clemca_python_prev_loop_dict[UUID] <= limit
def clemca_register_run(line):
    clemca_never_run_dict[line] += 1
def clemca_make_entry(line):
    clemca_never_run_dict[line] = 0
def clemca_print_never_run():
    for key in clemca_never_run_dict:
        if clemca_never_run_dict[key] == 0:
            print(key+":"+"!!! Never runs")
        else:
            print(key+":"+str(clemca_never_run_dict[key])+" iterations")
import atexit
def clemca_exit_handler():
    clemca_print_never_run()
atexit.register(clemca_exit_handler)\n`;
    let pythonCode = pythonStarterCode + GeneratePython(lines, 0);
    setKeysFromCode(sourceMap, pythonCode);
    console.log("generated python code", pythonCode, "with source map", sourceMap);
    let childProcess = child.spawn('python', ['-c', pythonCode]);
    let output = [] as string[];
    function kill() {
        if(childProcess.killed) return;
        childProcess.kill();
    }
    childProcess.stdout.on('data', (data) => {
        if(cancelToken.isCancellationRequested) return kill();
        output.push(...(data.toString() as string).split(/\r?\n(\d+:)/).reduce((acc, v, i) => {
            // might have line returns in print, we don't escape lines matching our format but we might want to do it in the future
            // it does require going out of your way to print \nd+: so the line number tacked on isn't on the same line
            // so at this point it's a feature
            if(i === 0 || v.match(/^\d+:$/)){
                acc.push(v);
                return acc;
            }
            acc[acc.length - 1] += v;
            return acc;
        }, [] as string[]).map(v => v.trim()).filter(v => v !== ''));
    });
    childProcess.stderr.on('data', (data) => {
        if(cancelToken.isCancellationRequested) return kill();
        let dataString = data.toString();
        let line = dataString.match(/ClemExcep(\d+):/)?.[1];
        if(line)
        {
            dataString = dataString.replace(/ClemExcep\d+:/, '').replace("Exception: ", "Python Prev:").trim();
        }
        else
        {
            function lookForIndex(index: number) {
                lines = pythonCode.split(/\r?\n/);
                for(let i = index; i >= 0; i--)
                {
                    if(lines[i].trim().match(/^\s*print\s*\(/)) return Number.parseInt(lines[i].split(':')[0]);
                }
                return -1;
            }
            let match = dataString.match(/line (\d+)/g);
            line = parseInt(match?.[match.length - 1].split(' ')[1]);
            line = (sourceMap.get(line) ?? (lookForIndex(line)+1)) - 1;
        }
        while (output.length < line) output.push(output.length + ':');
        if(line >= 0) {
            output.push(line+': Error: ' + dataString.trim());
        } else {
            output.push('0: Python Prev Internal Error: ' + dataString.trim());
        }
    });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            if(cancelToken.isCancellationRequested) reject();
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
            clearTimeout(timeout);
            if(cancelToken.isCancellationRequested) reject();
            resolve();
        });
    }).catch((_) => {});
    if(cancelToken.isCancellationRequested) return [];
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
        if(line.trim().startsWith("print ") || line.trim().startsWith("print("))
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
    const ignoreList = ["break", "continue", "pass", "except", "finally", "raise"];
    const neverRunCheck = ["if", "elif", "else", "while", "for"];
    let line = lines[lineI];
    if(line.trimStart().startsWith('@')) {
        return line + '\n' + GeneratePython(lines, lineI + 1, indentation);
    }
    let continueLine = lineI;
    let additionalLines = '';
    let returnPreviously = line.trim().startsWith('return');
    let [openChain, inString] = checkLineForOpen(line);
    console.log("before open chain", inString, openChain, line, continueLine);
    while(continueLine < lines.length - 1 && (lines[continueLine].trim().split('#')[0].endsWith('\\') || openChain > 0 || inString > 0)) { // all comments besides the first one are ignored
        let preComment = line.split('#')[0].split('\\')[0];
        let postComment = line.split('#')[1];
        line = preComment + (inString > 0 ? "\n"+lines[++continueLine].split('#')[0].split('\\')[0] : lines[++continueLine].trim().split('#')[0].split('\\')[0]);
        if(postComment) line += '#' + postComment;
        if(openChain > 0 || inString > 0) {
            let op;
            [op, inString] = checkLineForOpen(lines[continueLine], inString);
            openChain += op;
            additionalLines += 'print("' + continueLine + ':")\n';
        } else {
            if(returnPreviously) line = ' '.repeat(indentation) + `print("${continueLine}:")\n` + line;
            else additionalLines += 'print("' + continueLine + ':")\n';
        }
    }
    console.log("out of open chain", inString, openChain, line, continueLine);
    let checkLine = line + '';
    if(neverRunCheck.some(v => line.trimStart().startsWith(v+" ") || line.trimStart().startsWith(v+":"))) {
        let entryIndentation = indentationFromLine(checkLine, true);
        if(line.trim().startsWith('if') && line.trim().endsWith(':')) {
            line = " ".repeat(entryIndentation) + `clemca_make_entry('${lineI}')\n` + line;
            const elifLines = [];
            let elseLine = -1;
            let nextLine = lineI + 1;
            while(nextLine < lines.length && getIndent(lines[nextLine]) >= entryIndentation) {
                if(lines[nextLine].trim().startsWith('elif ')) {
                    elifLines.push(nextLine);
                } else if(lines[nextLine].trim().startsWith('else:')) {
                    elseLine = nextLine;
                }
                nextLine++;
            }
            if (elifLines.length > 0)
                line = elifLines.map(v => ' '.repeat(entryIndentation) + `clemca_make_entry('${v}')\n`).join('') + line;
            if (elseLine !== -1)
                line = ' '.repeat(entryIndentation) + `clemca_make_entry('${elseLine}')\n` + line;
        }
        else if(!line.trim().startsWith('else') && !line.trim().startsWith('elif')) {
            line = " ".repeat(entryIndentation) + `clemca_make_entry('${lineI}')\n` + line;
        }
        additionalLines += `clemca_register_run('${lineI}')\n`;
    }
    continueLine++;
    if (checkLine.trim() === '') {
        return ' '.repeat(indentation) + `print("${lineI}:")\n` + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
    }
    if(checkLine.match(/^\s*(?:elif|else)(?::|\s)/))
    {
        return line + '\n' + ' '.repeat(indentation) + `print("${lineI}:")\n` + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
    }
    line = mockInput(line, checkLine, indentation, lineI, lines);
    if(checkLine.trimStart().startsWith("def") && line.length > checkLine.length) {
        console.log("mocked def", line);
        let endOfDef = continueLine;
        while(endOfDef < lines.length && (lines[endOfDef].match(/^\s*/)?.[0].length ?? 0) > indentation) endOfDef++;
        return line + '\n' + GeneratePython(lines, endOfDef, indentation);
    }
    // line starts with assignment
    let assignmentMatch = checkLine.match(/^\s*[a-zA-Z_][a-zA-Z_0-9\.]*\s*=/);
    if (assignmentMatch) {
        // print the assignment
        indentation = indentationFromLine(checkLine);
        return line + '\n' + ' '.repeat(indentation) + `print("${lineI}: " + str(${assignmentMatch[0].replace(/=/, '').trim()}))\n` + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
    }
    let specialAssignmentMatch = checkLine.match(/^\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*([-\+\*\/])=/);
    if(specialAssignmentMatch)
    {
        let variable = specialAssignmentMatch[1];
        let operator = specialAssignmentMatch[2];
        let restOfLine = stripComments(checkLine.split('=')[1]).trim();
        indentation = indentationFromLine(checkLine);
        return ' '.repeat(indentation) + `print("${lineI}: " + str(${variable} ${operator} (${restOfLine})))\n` + line + '\n' + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
    }
    // line starts with print and isn't a multiline
    if (checkLine.match(/^\s*print\s*\(/) && !returnPreviously) {
        let modifiedLine = line.split("#")[0].replace(/print\s*\(/, `print("${lineI}:" + str(`);
        const firstComma = firstInContext(modifiedLine, ',', modifiedLine.indexOf('str(')+4);
        if(firstComma !== -1) modifiedLine = modifiedLine.slice(0, firstComma) + ')' + modifiedLine.slice(firstComma);
        else modifiedLine += ')';
        indentation = indentationFromLine(checkLine);
        return modifiedLine + '\n' + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
    }
    // line is a for loop
    if (checkLine.match(/^\s*for/)) {
        indentation = indentationFromLine(checkLine, true);
        let afterIn = checkLine.split('in')[1].split(':')[0].trim();
        return ' '.repeat(indentation) + `print("${lineI}:"+str(${afterIn}))\n` + line + '\n' + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation + indentSize) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation + indentSize);
    }
    if (checkLine.match(/^\s*return\s+/) || returnPreviously) {
        let nextIndentation = continueLine >= lines.length ? 0 : indentationFromLine(lines[continueLine], true);
        indentation = indentationFromLine(checkLine);
        let afterReturn = checkLine.split('return')[1].split('#')[0].trim();
        let beforeReturn = checkLine.split('return')[0]; // there's pregenerated stuff we want to keep
        if(afterReturn.indexOf(' ') !== -1) afterReturn = '(' + afterReturn + ')';
        return beforeReturn + `print("${lineI}:"+str(${afterReturn}))\n` + ' '.repeat(indentation) + 'return ' + afterReturn + '\n' + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, nextIndentation);
    }
    if (checkLine.match(/^\s*def\s*/) && !(checkLine.split('#')[1] ?? "").match(/mock\s?\(/)) {
        indentation = indentationFromLine(checkLine);
        let parameters = checkLine.split('(')[1].split(')')[0].split(',').map(v => v.split('=')[0].split(':')[0].trim()).filter((v, i) => i !== 0 || v !== "self").filter(v => v !== '');
        let parameterStrings = parameters.map(v => ' '.repeat(indentation) + `print("${lineI}:${v}: "+str(${v}))`);
        return line + '\n' + parameterStrings.join('\n') + '\n' + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
    }
    if (endsWithColon(checkLine)) {
        if(ignoreList.some(v => checkLine.trimStart().startsWith(v+" "))) {
            indentation = indentationFromLine(checkLine);
            return line + '\n' + GeneratePython(lines, continueLine, indentation);
        }
        indentation = indentationFromLine(checkLine, true);
        return ' '.repeat(indentation) + `print("${lineI}:")\n` + line + '\n' + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation + indentSize) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation + indentSize);
    }
    indentation = indentationFromLine(checkLine);
    if(ignoreList.some(v => checkLine.trim() === v || checkLine.trimStart().startsWith(v+" "))) {
        indentation = indentationFromLine(lines[continueLine] ?? lines[lines.length - 1], false);
        return line + '\n' + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
    }
    console.log("matched nothing for", checkLine);
    return line + '\n' + ' '.repeat(indentation) + `print("${lineI}:")\n` + additionalLines.split('\n').filter((v) => v.trim() !== "").map((v) => ' '.repeat(indentation) + v).join('\n') + (additionalLines.length > 0 ? '\n' : '') + GeneratePython(lines, continueLine, indentation);
}
function stripComments(line: string) {
    return line.split('#')[0];
}
function indentationFromLine(line: string, ignoreColon: boolean = false) {
    return getIndent(line) + (ignoreColon === false && endsWithColon(line) ? indentSize : 0);
}
function endsWithColon(line: string) {
    return stripComments(line).trimEnd().endsWith(':');
}
function mockInput(line: string, checkline: string, indentation: number, lineI: number, lines: string[]) {
    if(!checkline.match(/\s+input\s*\(/)) return line.replace(checkline, mockOrLimitLine(checkline, lineI, lines));
    let UUID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let comment = checkline.split('#')[1]?.trim() ?? '';
    let {mock, limit} = passComments(comment);
    let checkCode = ' '.repeat(indentation) + `if not clemca_check_UUID_count('${UUID}', ${limit ?? 100}):\n` + ' '.repeat(indentSize + indentation) + "raise Exception('ClemExcep"+lineI+":Too many calls to input. Use a mock comment if necessary.')\n";
    return checkCode + line.replace(checkline, checkline.replace(/input\(.*\)/, mock ?? '""'));
}

function mockOrLimitLine(line: string, lineI: number, lines: string[]) {
    let comment = line.split('#')[1]?.trim() ?? '';
    let {mock, limit} = passComments(comment);
    if(mock) line = mockLine(line, mock, lineI, lines);
    if(!limit) return line;
    let indentation = indentationFromLine(line, true);
    let UUID = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    return ' '.repeat(indentation) + `if not clemca_check_UUID_count('${UUID}', ${limit}):\n` + ' '.repeat(indentSize + indentation) + "raise Exception('ClemExcep"+lineI+":Too many calls.')\n"+line;
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

function getIndent(line: string) {
    for (let i = 0; i < line.length; i++) {
        if (line[i] !== ' ') {
            return i;
        }
    }
    return line.length;
}

function firstInContext(text: string, char: string, from: number) {
    let stack = 0;
    for (let i = from; i < text.length; i++) {
        [i] = skipString(text, i, 0);
        if (['(', '[', '{'].includes(text[i])) stack++;
        if ([')', ']', '}'].includes(text[i])) stack--;
        if (text[i] === char && stack === 0) return i;
        if(stack < 0) return -1;
    }
    return -1;
}


function checkLineForOpen(line: string, inString: number = 0) {
    let openChain = 0;
    const splitString = line.split('#')[0].split('');
    for(let i = 0; i < splitString.length; i++) {
        if(splitString[i].trim() === '') continue;
        let found;
        [i, found, inString] = skipString(line, i, inString);
        if(inString > 0) continue;
        if(splitString[i] === '(' || splitString[i] === '[' || splitString[i] === '{') openChain++;
        if(splitString[i] === ')' || splitString[i] === ']' || splitString[i] === '}') openChain--;
    }
    if(openChain > 0)
        console.log("open chain", openChain, "in string", inString, "from", line);
    return [openChain, inString];
}

function skipString(line: string, index: number, inString: number): [number, boolean, number] {
    if(inString === 0 && line[index] !== '"' && line[index] !== "'") return [index, false, 0];
    if(inString === 3 || (inString === 0 && line[index] === '"' && line[index+1] === '"'))
    {
        if(inString === 3 || line[index+2] === '"') {
            let targetIndex = line.indexOf('"""', index+3-inString);
            while(targetIndex !== -1 && line[targetIndex-1] === '\\'){
                targetIndex = line.indexOf('"""', targetIndex+3);
            }
            if(targetIndex === -1) return [line.length, true, 3];
            return [targetIndex+3, true, 0];
        };
        return [index+2, true, 0];
    }
    if(inString === 2 || (inString === 0 && line[index] === '"')) {
        let targetIndex = line.indexOf('"', inString === 2 ? index : index+1);
        while(targetIndex === -1 || line[targetIndex-1] === '\\'){
            targetIndex = line.indexOf('"', targetIndex+1);
        }
        if(targetIndex === -1) return [line.length, true, 2];
        return [targetIndex+1, true, 0];
    }
    if(inString === 1 || line[index] === "'")
    {
        let targetIndex = line.indexOf("'", index+1-inString);
        while(targetIndex === -1 || line[targetIndex-1] === '\\'){
            targetIndex = line.indexOf("'", targetIndex+1);
        }
        if(targetIndex === -1) return [line.length, true, 1];
        return [targetIndex+1, true, 0];
    }
    throw new Error("Shouldn't ever happen");
}