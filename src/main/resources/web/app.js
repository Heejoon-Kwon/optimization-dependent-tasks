import { renderGraph, taskNumber } from './graph.js';

const MAX_TASKS = 100;
const MAX_RESOURCES = 100;
const MAX_CAPACITY = 100;
const MAX_DURATION = 1_000_000;
const MAX_ID = 2_147_483_647;
const STORAGE_KEY = 'flowline.tasks.v1';
const FILE_FORMAT = 'flowline-project';
const FILE_VERSION = 1;
const MAX_FILE_SIZE = 1024 * 1024;
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
const scheduleOrder = byId('schedule-order');
const addResource = byId('add-resource');
const projectTitle = byId('project-title');
const projectFile = byId('project-file');
const fileStatus = byId('file-status');
const resourceNumber = id => 'R' + String(id).padStart(2, '0');

const samples = {
    cafe: {
        resources: [[1, '작업자', 1], [2, '커피 머신', 1]],
        tasks: [
            [1, '버튼 조작', 1, [], [1]],
            [2, '장비 예열', 8, [1], [2]],
            [3, '원두 계량', 4, [], [1]],
            [4, '재료 준비', 6, [], [1]],
            [5, '마무리', 2, [2, 3, 4], [1, 2]]
        ]
    },
    office: {
        resources: [[1, '작업자', 2]],
        tasks: [
            [1, '원자료 수집', 20, [], [1]],
            [2, '보고서 틀 작성', 10, [], [1]],
            [3, '지표 검증', 25, [1], [1]],
            [4, '요약 작성', 15, [2, 3], [1]],
            [5, '차트 제작', 20, [3], [1]],
            [6, '보고서 검토', 10, [4, 5], [1]],
            [7, '보고서 배포', 5, [6], [1]]
        ]
    },
    blank: { resources: [], tasks: [[1, '', '', [], []]] }
};

let { tasks, resources, title, fileDirty = false } = loadInput() ?? exampleInput('cafe');
projectTitle.value = title;
let nextId = nextNumber(tasks);
let nextResourceId = nextNumber(resources);
let hasResult = false;
let pending = null;
let disposeGraph = null;
let displayGraph = null;

function nextNumber(list) {
    return Math.max(0, ...list.map(item => item.id)) + 1;
}

function exampleInput(key) {
    const example = samples[key];
    return {
        title: { cafe: '카페 음료 준비', office: '월간 보고서 작성', blank: '' }[key],
        resources: example.resources.map(([id, name, capacity]) => ({ id, name, capacity: String(capacity) })),
        tasks: example.tasks.map(([id, name, duration, prerequisites, resourceIds]) => ({
            id, name, duration: String(duration), prerequisites: [...prerequisites],
            demands: resourceIds.map(resourceId => ({ resourceId, quantity: 1 }))
        }))
    };
}

function savedIds(list, maximum, numericField) {
    if (!Array.isArray(list) || list.length > maximum) return null;
    const ids = new Set();
    for (const item of list) {
        if (!item || !Number.isInteger(item.id) || item.id < 1 || item.id > MAX_ID || ids.has(item.id)
            || typeof item.name !== 'string' || item.name.length > 80 || typeof item[numericField] !== 'string') return null;
        ids.add(item.id);
    }
    return ids;
}

function decodeInput(saved) {
    if (!saved) return null;
    const oldFormat = Array.isArray(saved);
    const savedTasks = oldFormat ? saved : saved.tasks;
    const savedResources = oldFormat ? [] : saved.resources;
    const taskIds = savedIds(savedTasks, MAX_TASKS, 'duration');
    const resourceIds = savedIds(savedResources, MAX_RESOURCES, 'capacity');
    const savedTitle = saved.title ?? '';
    if (!taskIds?.size || !resourceIds || typeof savedTitle !== 'string' || savedTitle.length > 80) return null;
    for (const task of savedTasks) {
        if (!Array.isArray(task.prerequisites)
            || task.prerequisites.some(id => id === task.id || !taskIds.has(id))
            || new Set(task.prerequisites).size !== task.prerequisites.length) return null;
        if (oldFormat) task.demands = [];
        if (!Array.isArray(task.demands) || task.demands.some(demand => !demand
            || !resourceIds.has(demand.resourceId) || !Number.isInteger(demand.quantity) || demand.quantity < 1
            || demand.quantity > MAX_CAPACITY)
            || new Set(task.demands.map(demand => demand.resourceId)).size !== task.demands.length) return null;
    }
    return { tasks: savedTasks, resources: savedResources, title: savedTitle };
}

function loadInput() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        const input = decodeInput(saved);
        return input && { ...input, fileDirty: saved.fileDirty !== false };
    } catch {
        return null;
    }
}

function saveInput() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks, resources, title, fileDirty }));
    } catch {
        // The form and server analysis also work when browser storage is unavailable.
    }
}

function showFileStatus(message, failed = false) {
    fileStatus.textContent = message;
    fileStatus.dataset.error = String(failed);
    fileStatus.hidden = false;
}

function downloadProject() {
    const label = title.trim() || '작업 일정';
    const name = label.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'schedule';
    const body = JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, title: label, resources, tasks });
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name + '.schedule.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    fileDirty = false;
    saveInput();
    showFileStatus(link.download + ' 다운로드를 요청했습니다.');
}

async function openProject(file) {
    try {
        if (file.size > MAX_FILE_SIZE) {
            showFileStatus('1MB 이하의 일정 파일을 선택하세요.', true);
            return;
        }
        const data = JSON.parse(await file.text());
        const input = data?.format === FILE_FORMAT && data.version === FILE_VERSION && decodeInput(data);
        if (!input) {
            showFileStatus('이 프로그램에서 저장한 일정 파일을 선택하세요.', true);
            return;
        }
        if (fileDirty && !window.confirm('파일로 저장하지 않은 변경 사항이 있습니다. 선택한 일정으로 바꿀까요?')) return;
        replaceInput(input);
        showFileStatus('‘' + (title || file.name) + '’ 일정을 열었습니다.');
    } catch {
        showFileStatus('일정 파일을 읽을 수 없습니다. JSON 파일을 확인하세요.', true);
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
    fileDirty = true;
    fileStatus.hidden = true;
    saveInput();
    resetAnalysis();
}

function resetAnalysis() {
    if (pending) {
        pending.abort();
        pending = null;
    }
    setBusy(false);
    error.hidden = true;
    if (hasResult) setStatus('입력이 변경되었습니다 · 다시 분석하세요', 'stale');
    else setStatus('분석 대기 중');
}

function closeMenus(except) {
    for (const menu of document.querySelectorAll('details[open]')) {
        if (menu !== except) menu.open = false;
    }
}

function picker(name, placeholder, values, populate) {
    const details = make('details', 'dependencies');
    const summary = make('summary', '');
    const label = make('span', 'dependency-summary');
    const chevron = make('span', 'chevron');
    chevron.setAttribute('aria-hidden', 'true');
    summary.append(label, chevron);
    const menu = make('div', 'dependency-menu');
    const options = make('div', 'dependency-options');
    const actions = make('div', 'picker-actions');
    const done = make('button', 'small-button', '완료');
    done.type = 'button';
    done.addEventListener('click', () => {
        details.open = false;
        summary.focus();
    });
    actions.append(done);
    menu.append(options, actions);
    details.append(summary, menu);
    function update() {
        const selected = values();
        const text = selected.join(', ');
        label.textContent = text || placeholder;
        summary.classList.toggle('has-dependencies', selected.length > 0);
        summary.setAttribute('aria-label', name + ' ' + (text || placeholder));
        summary.title = text;
    }
    function change() {
        update();
        onEdit();
    }
    update();
    details.addEventListener('toggle', () => {
        if (!details.open) return;
        closeMenus(details);
        options.replaceChildren();
        populate(options, change);
    });
    return details;
}

function checkOption(text, checked) {
    const option = make('label', 'dependency-option');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    option.append(checkbox, make('span', '', text));
    return { option, checkbox };
}

function buildDependencies(task) {
    return picker(taskNumber(task.id) + ' 선행 작업', '선택', () => task.prerequisites.map(taskNumber), (options, change) => {
        for (const other of tasks) {
            if (other.id === task.id) continue;
            const text = taskNumber(other.id) + ' ' + (other.name.trim() || '이름 없는 작업');
            const { option, checkbox } = checkOption(text, task.prerequisites.includes(other.id));
            options.append(option);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    task.prerequisites.push(other.id);
                    task.prerequisites.sort((a, b) => a - b);
                } else {
                    task.prerequisites = task.prerequisites.filter(id => id !== other.id);
                }
                change();
            });
        }
        if (!options.childElementCount) options.append(make('p', '', '선택할 작업이 없습니다.'));
    });
}

function buildDemands(task) {
    const values = () => task.demands.map(demand => resourceNumber(demand.resourceId)
        + (demand.quantity > 1 ? '×' + demand.quantity : ''));
    return picker(taskNumber(task.id) + ' 사용 자원', '없음', values, (options, change) => {
        for (const resource of resources) {
            let demand = task.demands.find(item => item.resourceId === resource.id);
            const number = resourceNumber(resource.id);
            const text = number + ' ' + (resource.name.trim() || '이름 없는 자원');
            const { option, checkbox } = checkOption(text, Boolean(demand));
            const row = make('div', 'resource-option');
            const quantity = make('select', 'resource-quantity');
            quantity.setAttribute('aria-label', number + ' 사용량');
            const capacity = Math.max(1, Math.min(MAX_CAPACITY, Math.floor(Number(resource.capacity)) || 1));
            for (let i = 1; i <= Math.max(capacity, demand?.quantity ?? 1); i++) {
                quantity.add(new Option(i + '개' + (i > capacity ? ' (용량 초과)' : ''), String(i)));
            }
            quantity.value = demand?.quantity ?? 1;
            quantity.hidden = !demand || quantity.options.length === 1;
            quantity.addEventListener('change', () => {
                demand.quantity = Number(quantity.value);
                change();
            });
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    demand = { resourceId: resource.id, quantity: Number(quantity.value) };
                    task.demands.push(demand);
                    task.demands.sort((a, b) => a.resourceId - b.resourceId);
                } else {
                    task.demands = task.demands.filter(item => item !== demand);
                    quantity.value = '1';
                }
                quantity.hidden = !checkbox.checked || quantity.options.length === 1;
                change();
            });
            row.append(option, quantity);
            options.append(row);
        }
        if (!options.childElementCount) options.append(make('p', '', '자원 목록에 자원을 추가하세요.'));
    });
}

function drawResources(focusId) {
    const fragment = document.createDocumentFragment();
    for (const resource of resources) {
        const number = resourceNumber(resource.id);
        const row = make('div', 'resource-grid task-row');
        const name = document.createElement('input');
        name.type = 'text';
        name.value = resource.name;
        name.id = 'resource-name-' + resource.id;
        name.required = true;
        name.maxLength = 80;
        name.placeholder = '예: 작업자';
        name.setAttribute('aria-label', number + ' 자원 이름');
        name.addEventListener('input', () => {
            resource.name = name.value;
            name.setCustomValidity('');
            onEdit();
        });

        const capacity = document.createElement('input');
        capacity.type = 'number';
        capacity.value = resource.capacity;
        capacity.required = true;
        capacity.min = '1';
        capacity.max = MAX_CAPACITY;
        capacity.step = '1';
        capacity.inputMode = 'numeric';
        capacity.setAttribute('aria-label', number + ' 자원 수량');
        capacity.addEventListener('input', () => {
            resource.capacity = capacity.value;
            onEdit();
        });

        const remove = make('button', 'remove-task', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', number + ' 자원 삭제');
        remove.addEventListener('click', () => {
            const index = resources.indexOf(resource);
            resources.splice(index, 1);
            for (const task of tasks) {
                task.demands = task.demands.filter(demand => demand.resourceId !== resource.id);
            }
            drawResources(resources[Math.min(index, resources.length - 1)]?.id);
            drawRows();
            if (!resources.length) addResource.focus();
            onEdit();
        });
        row.append(make('span', 'row-id', number), name, capacity, remove);
        fragment.append(row);
    }
    byId('resource-rows').replaceChildren(fragment);
    byId('resource-head').hidden = resources.length === 0;
    byId('resource-empty').hidden = resources.length !== 0;
    addResource.disabled = resources.length >= MAX_RESOURCES || nextResourceId > MAX_ID;
    if (focusId !== undefined) byId('resource-name-' + focusId).focus();
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
        row.append(make('span', 'row-id', number), name, duration, buildDependencies(task), buildDemands(task), remove);
        fragment.append(row);
    }
    rows.replaceChildren(fragment);
    addButton.disabled = tasks.length >= MAX_TASKS || nextId > MAX_ID;
    if (focusId !== undefined) byId('task-name-' + focusId).focus();
}

function replaceResult(schedule, input, inputResources) {
    const result = schedule.optimized;
    byId('optimized-duration').textContent = formatter.format(result.duration);
    byId('optimality').textContent = result.optimal ? '최적 확인' : '탐색 하한 ' + formatter.format(result.lowerBound) + '분';
    byId('parallel-duration').textContent = formatter.format(schedule.parallelDuration);
    byId('task-count').textContent = formatter.format(input.length);
    byId('dependency-count').textContent = '선행 관계 ' + formatter.format(schedule.edges.length) + '개';

    const tasksById = new Map(input.map(task => [task.id, task]));
    const resourcesById = new Map(inputResources.map(resource => [resource.id, resource]));
    const criticalTasks = new Set(result.timings.filter(timing => timing.slack === 0).map(timing => timing.taskId));
    const steps = result.order.map(step => {
        const task = tasksById.get(step.taskId);
        const row = make('li', 'serial-step');
        row.classList.toggle('is-critical', criticalTasks.has(task.id));
        const name = make('span', 'step-task');
        name.append(make('strong', '', task.name));
        const occupied = task.demands.map(demand => resourcesById.get(demand.resourceId).name
            + (demand.quantity > 1 ? ' ×' + demand.quantity : '')).join(', ');
        if (occupied) {
            const label = make('span', 'step-resources', occupied);
            label.title = occupied;
            name.append(label);
        }
        const interval = formatter.format(step.start) + '–' + formatter.format(step.finish) + '분';
        row.append(make('span', 'step-number', taskNumber(task.id).slice(1)), name, make('span', 'step-time', interval));
        return row;
    });
    scheduleOrder.replaceChildren(...steps);
    scheduleOrder.hidden = false;
    byId('order-empty').hidden = true;

    byId('graph-controls').hidden = false;
    byId('graph-modes').hidden = false;
    byId('graph-footer').hidden = false;
    displayGraph = dependenciesOnly => {
        disposeGraph?.();
        byId('optimized-graph').setAttribute('aria-pressed', String(!dependenciesOnly));
        byId('dependency-graph').setAttribute('aria-pressed', String(dependenciesOnly));
        byId('resource-legend').hidden = dependenciesOnly || result.resourceLinks.length === 0;
        byId('graph-description').textContent = dependenciesOnly
            ? '자원 용량이 충분할 때의 임계 경로입니다.'
            : '현재 자원으로 계산한 일정의 임계 경로입니다.';
        disposeGraph = renderGraph(graphViewport, {
            zoomOut: byId('zoom-out'),
            zoomFit: byId('zoom-fit'),
            zoomIn: byId('zoom-in')
        }, byId('node-detail'), input, dependenciesOnly ? schedule : result, resourcesById);
    };
    displayGraph(false);
    hasResult = true;
}

function clearResult() {
    disposeGraph?.();
    disposeGraph = null;
    hasResult = false;
    displayGraph = null;
    byId('optimality').textContent = '자원 용량 반영';
    byId('graph-description').textContent = '선행 관계와 실행 일정의 임계 경로를 확인하세요.';
    for (const metric of ['optimized-duration', 'parallel-duration', 'task-count']) byId(metric).textContent = '—';
    byId('dependency-count').textContent = '선행 관계 —';
    byId('graph-controls').hidden = true;
    byId('graph-modes').hidden = true;
    byId('graph-footer').hidden = true;
    graphViewport.replaceChildren(make('p', 'graph-empty', '작업을 분석하면 그래프가 여기에 표시됩니다.'));
    scheduleOrder.replaceChildren();
    scheduleOrder.hidden = true;
    byId('order-empty').hidden = false;
}

async function analyze() {
    const unnamedResource = resources.find(resource => resource.name.trim() === '');
    if (unnamedResource) {
        const field = byId('resource-name-' + unnamedResource.id);
        field.setCustomValidity('자원 이름을 입력하세요.');
        field.reportValidity();
        return;
    }
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
        id: task.id, name: task.name.trim(), duration: Number(task.duration),
        prerequisites: [...task.prerequisites], demands: task.demands.map(demand => ({ ...demand }))
    }));
    const inputResources = resources.map(resource => ({
        id: resource.id, name: resource.name.trim(), capacity: Number(resource.capacity)
    }));
    try {
        const response = await fetch('/api/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasks: input, resources: inputResources }),
            signal: controller.signal
        });
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
            showError(data.error || '분석할 수 없습니다. 작업 목록을 확인하세요.');
            return;
        }
        replaceResult(data, input, inputResources);
        setStatus(data.optimized.optimal ? '분석 완료' : '탐색 한도 도달', data.optimized.optimal ? 'done' : 'stale');
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

byId('optimized-graph').addEventListener('click', () => displayGraph?.(false));
byId('dependency-graph').addEventListener('click', () => displayGraph?.(true));
addResource.addEventListener('click', () => {
    if (resources.length >= MAX_RESOURCES || nextResourceId > MAX_ID) return;
    const resource = { id: nextResourceId++, name: '', capacity: '1' };
    resources.push(resource);
    drawResources(resource.id);
    onEdit();
});

addButton.addEventListener('click', () => {
    if (tasks.length >= MAX_TASKS || nextId > MAX_ID) return;
    const task = { id: nextId++, name: '', duration: '', prerequisites: [], demands: [] };
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
function replaceInput(input, focusId) {
    ({ tasks, resources, title } = input);
    projectTitle.value = title;
    nextId = nextNumber(tasks);
    nextResourceId = nextNumber(resources);
    examples.open = false;
    fileDirty = false;
    fileStatus.hidden = true;
    clearResult();
    resetAnalysis();
    saveInput();
    drawResources();
    drawRows(focusId);
}

examples.addEventListener('click', event => {
    const key = event.target.closest('button[data-example]')?.dataset.example;
    if (!key) return;
    const input = exampleInput(key);
    replaceInput(input, key === 'blank' ? input.tasks[0].id : undefined);
    if (key !== 'blank') void analyze();
});

projectTitle.addEventListener('input', () => {
    title = projectTitle.value;
    fileDirty = true;
    fileStatus.hidden = true;
    saveInput();
});
byId('save-project').addEventListener('click', downloadProject);
byId('open-project').addEventListener('click', () => projectFile.click());
projectFile.addEventListener('change', () => {
    const [file] = projectFile.files;
    projectFile.value = '';
    if (file) void openProject(file);
});

document.addEventListener('click', event => closeMenus(event.target.closest('details')));
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = document.querySelector('details[open]');
    if (!menu) return;
    menu.open = false;
    menu.querySelector('summary').focus();
});

drawResources();
drawRows();
if (form.checkValidity() && [...tasks, ...resources].every(item => item.name.trim())) void analyze();
