import { renderGraph, taskNumber } from './graph.js';

const MAX_TASKS = 100;
const MAX_DURATION = 1_000_000;
const MAX_ID = 2_147_483_647;
const STORAGE_KEY = 'flowline.tasks.v1';
const formatter = new Intl.NumberFormat('ko-KR');
const byId = id => document.getElementById(id);
const form = byId('tasks-form');
const rows = byId('task-rows');
const examples = byId('examples');
const status = byId('result-status');
const error = byId('form-error');
const analyzeButton = byId('analyze');
const addButton = byId('add-task');
const graphViewport = byId('graph-viewport');
const serialOrder = byId('serial-order');

const samples = {
    cafe: [
        [1, '장비 예열', 8, []],
        [2, '원두 계량', 4, []],
        [3, '재료 준비', 6, []],
        [4, '에스프레소 추출', 5, [1, 2]],
        [5, '우유 스티밍', 4, [1, 3]],
        [6, '음료 조립', 4, [4, 5]],
        [7, '서빙', 3, [6]]
    ],
    office: [
        [1, '원자료 수집', 20, []],
        [2, '보고서 틀 작성', 10, []],
        [3, '지표 검증', 25, [1]],
        [4, '요약 작성', 15, [2, 3]],
        [5, '차트 제작', 20, [3]],
        [6, '보고서 검토', 10, [4, 5]],
        [7, '보고서 배포', 5, [6]]
    ],
    blank: [[1, '', '', []]]
};

let tasks = loadTasks() ?? exampleTasks('cafe');
let nextId = Math.max(...tasks.map(task => task.id)) + 1;
let hasResult = false;
let pending = null;
let disposeGraph = null;

function exampleTasks(key) {
    return samples[key].map(([id, name, duration, prerequisites]) => ({
        id, name, duration: String(duration), prerequisites: [...prerequisites]
    }));
}

function loadTasks() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!Array.isArray(saved) || saved.length < 1 || saved.length > MAX_TASKS) return null;
        const ids = new Set();
        for (const task of saved) {
            if (!task || !Number.isInteger(task.id) || task.id < 1 || task.id > MAX_ID || ids.has(task.id)
                || typeof task.name !== 'string' || task.name.length > 80
                || typeof task.duration !== 'string' || !Array.isArray(task.prerequisites)) return null;
            ids.add(task.id);
        }
        if (saved.some(task => task.prerequisites.some(id => id === task.id || !ids.has(id)))) return null;
        return saved;
    } catch {
        return null;
    }
}

function saveTasks() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
        // The form and server analysis also work when browser storage is unavailable.
    }
}

function make(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function setStatus(text, state = '') {
    status.textContent = text;
    status.dataset.state = state;
}

function setBusy(busy) {
    analyzeButton.disabled = busy;
    byId('analyze-label').textContent = busy ? '분석 중…' : '작업 분석하기';
}

function onEdit() {
    saveTasks();
    if (pending) {
        pending.abort();
        pending = null;
    }
    setBusy(false);
    error.hidden = true;
    if (hasResult) setStatus('입력이 변경되었습니다 · 다시 분석하세요', 'stale');
    else setStatus('분석 대기 중');
}

function updateDependencySummary(task, summary, label) {
    const dependencyIds = task.prerequisites.map(taskNumber);
    label.textContent = dependencyIds.length > 0 ? dependencyIds.join(', ') : '선택';
    summary.classList.toggle('has-dependencies', dependencyIds.length > 0);
    summary.setAttribute('aria-label', taskNumber(task.id) + ' 선행 작업 ' + (dependencyIds.join(', ') || '선택'));
    summary.title = dependencyIds.join(', ');
}

function closeMenus(except) {
    for (const menu of document.querySelectorAll('details[open]')) {
        if (menu !== except) menu.open = false;
    }
}

function buildDependencies(task) {
    const details = make('details', 'dependencies');
    const summary = make('summary', '');
    const label = make('span', 'dependency-summary');
    const chevron = make('span', 'chevron');
    chevron.setAttribute('aria-hidden', 'true');
    summary.append(label, chevron);
    updateDependencySummary(task, summary, label);

    const menu = make('div', 'dependency-menu');
    const options = make('div', 'dependency-options');
    menu.append(options);
    details.append(summary, menu);
    details.addEventListener('toggle', () => {
        if (!details.open) return;
        closeMenus(details);
        options.replaceChildren();
        for (const other of tasks) {
            if (other.id === task.id) continue;
            const option = make('label', 'dependency-option');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = task.prerequisites.includes(other.id);
            const text = make('span', '', taskNumber(other.id) + ' ' + (other.name.trim() || '이름 없는 작업'));
            option.append(checkbox, text);
            options.append(option);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    task.prerequisites.push(other.id);
                    task.prerequisites.sort((a, b) => a - b);
                } else {
                    task.prerequisites = task.prerequisites.filter(id => id !== other.id);
                }
                updateDependencySummary(task, summary, label);
                onEdit();
            });
        }
        if (options.childElementCount === 0) {
            options.append(make('p', '', '선택할 작업이 없습니다.'));
        }
    });
    return details;
}

function drawRows(focusId) {
    const fragment = document.createDocumentFragment();
    for (const task of tasks) {
        const row = make('div', 'task-grid task-row');
        const number = taskNumber(task.id);
        const name = document.createElement('input');
        name.type = 'text';
        name.value = task.name;
        name.id = 'task-name-' + task.id;
        name.required = true;
        name.maxLength = 80;
        name.placeholder = '작업 이름';
        name.setAttribute('aria-label', number + ' 작업 이름');
        name.addEventListener('input', () => {
            task.name = name.value;
            name.setCustomValidity('');
            onEdit();
        });

        const duration = document.createElement('input');
        duration.type = 'number';
        duration.value = task.duration;
        duration.required = true;
        duration.min = '1';
        duration.max = MAX_DURATION;
        duration.step = '1';
        duration.inputMode = 'numeric';
        duration.placeholder = '분';
        duration.setAttribute('aria-label', number + ' 소요 시간(분)');
        duration.addEventListener('input', () => {
            task.duration = duration.value;
            onEdit();
        });

        const remove = make('button', 'remove-task', '×');
        remove.type = 'button';
        remove.disabled = tasks.length === 1;
        remove.setAttribute('aria-label', number + ' 작업 삭제');
        remove.addEventListener('click', () => {
            const i = tasks.indexOf(task);
            tasks.splice(i, 1);
            for (const remaining of tasks) {
                remaining.prerequisites = remaining.prerequisites.filter(id => id !== task.id);
            }
            drawRows(tasks[Math.min(i, tasks.length - 1)].id);
            onEdit();
        });
        row.append(make('span', 'row-id', number), name, duration, buildDependencies(task), remove);
        fragment.append(row);
    }
    rows.replaceChildren(fragment);
    addButton.disabled = tasks.length >= MAX_TASKS || nextId > MAX_ID;
    if (focusId !== undefined) byId('task-name-' + focusId).focus();
}

function replaceResult(schedule, input) {
    byId('serial-duration').textContent = formatter.format(schedule.serialDuration);
    byId('parallel-duration').textContent = formatter.format(schedule.parallelDuration);
    byId('task-count').textContent = formatter.format(input.length);
    byId('dependency-count').textContent = '선행 관계 ' + formatter.format(schedule.edges.length) + '개';

    const tasksById = new Map(input.map(task => [task.id, task]));
    const criticalTasks = new Set(schedule.timings.filter(timing => timing.slack === 0).map(timing => timing.taskId));
    const steps = schedule.serialOrder.map((step, index) => {
        const task = tasksById.get(step.taskId);
        const row = make('li', 'serial-step');
        row.classList.toggle('is-critical', criticalTasks.has(task.id));
        const name = make('span', 'step-task');
        name.append(make('strong', '', task.name), make('span', 'step-id', taskNumber(task.id)));
        const interval = formatter.format(step.start) + '–' + formatter.format(step.finish) + '분';
        row.append(make('span', 'step-number', String(index + 1).padStart(2, '0')), name, make('span', 'step-time', interval));
        return row;
    });
    serialOrder.replaceChildren(...steps);
    serialOrder.hidden = false;
    byId('order-empty').hidden = true;

    disposeGraph?.();
    byId('graph-controls').hidden = false;
    byId('graph-footer').hidden = false;
    disposeGraph = renderGraph(graphViewport, {
        zoomOut: byId('zoom-out'),
        zoomFit: byId('zoom-fit'),
        zoomIn: byId('zoom-in')
    }, byId('node-detail'), input, schedule);
    hasResult = true;
}

function clearResult() {
    disposeGraph?.();
    disposeGraph = null;
    hasResult = false;
    for (const metric of ['serial-duration', 'parallel-duration', 'task-count']) byId(metric).textContent = '—';
    byId('dependency-count').textContent = '선행 관계 —';
    byId('graph-controls').hidden = true;
    byId('graph-footer').hidden = true;
    graphViewport.replaceChildren(make('p', 'graph-empty', '작업을 분석하면 그래프가 여기에 표시됩니다.'));
    serialOrder.replaceChildren();
    serialOrder.hidden = true;
    byId('order-empty').hidden = false;
}

async function analyze() {
    const unnamed = tasks.find(task => task.name.trim() === '');
    if (unnamed) {
        const input = byId('task-name-' + unnamed.id);
        input.setCustomValidity('작업 이름을 입력하세요.');
        input.reportValidity();
        return;
    }
    const controller = new AbortController();
    pending = controller;
    closeMenus();
    error.hidden = true;
    setBusy(true);
    setStatus('분석 중…');

    const input = tasks.map(task => ({
        id: task.id, name: task.name.trim(), duration: Number(task.duration), prerequisites: [...task.prerequisites]
    }));
    try {
        const response = await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasks: input }),
            signal: controller.signal
        });
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
            showError(data.error || '분석할 수 없습니다. 작업 목록을 확인하세요.');
            return;
        }
        replaceResult(data, input);
        setStatus('분석 완료', 'done');
    } catch {
        if (!controller.signal.aborted) showError('분석을 완료하지 못했습니다. 잠시 후 다시 시도하세요.');
    } finally {
        if (pending === controller) {
            pending = null;
            setBusy(false);
        }
    }
}

function showError(message) {
    error.textContent = message;
    error.hidden = false;
    setStatus(hasResult ? '이전 분석 결과 표시 중' : '분석 실패', 'error');
}

addButton.addEventListener('click', () => {
    if (tasks.length >= MAX_TASKS || nextId > MAX_ID) return;
    const task = { id: nextId++, name: '', duration: '', prerequisites: [] };
    tasks.push(task);
    drawRows(task.id);
    onEdit();
});

form.addEventListener('submit', event => {
    event.preventDefault();
    if (!pending) void analyze();
});

examples.addEventListener('toggle', () => {
    if (examples.open) closeMenus(examples);
});
examples.addEventListener('click', event => {
    const key = event.target.closest('button[data-example]')?.dataset.example;
    if (!key) return;
    tasks = exampleTasks(key);
    nextId = Math.max(...tasks.map(task => task.id)) + 1;
    examples.open = false;
    clearResult();
    onEdit();
    drawRows(key === 'blank' ? tasks[0].id : undefined);
    if (key !== 'blank') void analyze();
});

document.addEventListener('click', event => closeMenus(event.target.closest('details')));
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = document.querySelector('details[open]');
    if (!menu) return;
    menu.open = false;
    menu.querySelector('summary').focus();
});

drawRows();
if (form.checkValidity() && tasks.every(task => task.name.trim())) void analyze();
