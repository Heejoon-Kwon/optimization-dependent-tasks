const NODE_WIDTH = 140;
const NODE_HEIGHT = 53;
const COLUMN_GAP = 44;
const ROW_GAP = 16;
const PADDING = 18;
const MIN_ZOOM = .01;
const MAX_ZOOM = 2;
const formatter = new Intl.NumberFormat('ko-KR');

export function taskNumber(id) {
    return '#' + String(id).padStart(2, '0');
}

function make(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function layout(timings, edges) {
    const columns = [];
    for (const timing of timings) {
        (columns[timing.level] ??= []).push(timing);
    }
    for (const column of columns) {
        column.sort((a, b) => Number(a.slack !== 0) - Number(b.slack !== 0) || a.taskId - b.taskId);
    }

    const positions = new Map();
    const levels = new Map(timings.map(timing => [timing.taskId, timing.level]));
    const hasLongEdges = edges.some(edge => levels.get(edge.to) - levels.get(edge.from) > 1);
    const top = hasLongEdges ? PADDING + 30 : PADDING;
    const rowCount = Math.max(...columns.map(column => column.length));
    for (const [level, column] of columns.entries()) {
        const x = PADDING + level * (NODE_WIDTH + COLUMN_GAP);
        const offsetY = (rowCount - column.length) * (NODE_HEIGHT + ROW_GAP) / 2;
        for (const [row, timing] of column.entries()) {
            const y = top + offsetY + row * (NODE_HEIGHT + ROW_GAP);
            positions.set(timing.taskId, { x, y, level });
        }
    }
    return {
        positions,
        width: 2 * PADDING + columns.length * NODE_WIDTH + (columns.length - 1) * COLUMN_GAP,
        height: top + PADDING + rowCount * NODE_HEIGHT + (rowCount - 1) * ROW_GAP
    };
}

export function renderGraph(viewport, controls, detail, tasks, schedule, resources) {
    const { zoomOut, zoomFit, zoomIn } = controls;
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const timingById = new Map(schedule.timings.map(timing => [timing.taskId, timing]));
    const resourceLinks = schedule.resourceLinks ?? [];
    const resourceByEdge = new Map(resourceLinks.map(link => [link.from + ':' + link.to, link.resourceIds]));
    const { positions, width, height } = layout(schedule.timings, schedule.edges);

    const surface = make('div', 'graph-surface');
    const canvas = make('canvas', 'graph-edges');
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    const world = make('div', 'graph-world');
    const nodes = new Map();
    let selected = null;
    let related = new Set();
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let frame = 0;
    let autoFit = true;

    const criticalPath = schedule.criticalPath.map(id => taskById.get(id));
    const ties = schedule.edges.filter(edge => edge.critical).length > criticalPath.length - 1
        || schedule.timings.filter(timing => timing.slack === 0).length > criticalPath.length;
    const pathLabel = ties ? '임계 경로 예시' : '임계 경로';
    const pathNames = criticalPath.map((task, index) => {
        const name = criticalPath.length <= 7 ? task.name : taskNumber(task.id);
        if (index === 0) return name;
        const previous = criticalPath[index - 1];
        return (resourceByEdge.has(previous.id + ':' + task.id) ? ' ⇢ ' : ' → ') + name;
    }).join('');

    function updateDetail() {
        if (selected === null) {
            detail.replaceChildren(make('strong', '', pathLabel), document.createTextNode(' · ' + pathNames));
            return;
        }
        const task = taskById.get(selected);
        const timing = timingById.get(selected);
        const interval = formatter.format(timing.earliestStart) + '–' + formatter.format(timing.earliestFinish) + '분';
        const predecessors = task.prerequisites.map(taskNumber);
        const successors = schedule.edges.filter(edge => edge.from === selected
            && !resourceByEdge.has(edge.from + ':' + edge.to)).map(edge => taskNumber(edge.to));
        const resourceDetails = resourceLinks.filter(link => link.from === selected || link.to === selected)
            .map(link => taskNumber(link.from) + ' ⇢ ' + taskNumber(link.to) + ' (' + link.resourceIds.map(id => resources.get(id).name).join(', ') + ')');
        const details = [interval, '여유 ' + formatter.format(timing.slack) + '분'];
        if (predecessors.length > 0) details.push('선행 ' + predecessors.join(', '));
        if (successors.length > 0) details.push('후속 ' + successors.join(', '));
        if (resourceDetails.length > 0) details.push('자원 인계 ' + resourceDetails.join(', '));
        detail.replaceChildren(
            make('strong', '', taskNumber(task.id) + ' ' + task.name),
            document.createTextNode(' · ' + details.join(' · '))
        );
    }

    function select(id) {
        selected = selected === id ? null : id;
        related = new Set([selected]);
        for (const edge of schedule.edges) {
            if (edge.from === selected) related.add(edge.to);
            if (edge.to === selected) related.add(edge.from);
        }
        for (const [taskId, node] of nodes) {
            node.classList.toggle('selected', taskId === selected);
            node.classList.toggle('dimmed', selected !== null && !related.has(taskId));
            node.setAttribute('aria-pressed', String(taskId === selected));
        }
        updateDetail();
        queueDraw();
    }

    for (const timing of [...schedule.timings].sort((a, b) => a.level - b.level || positions.get(a.taskId).y - positions.get(b.taskId).y)) {
        const task = taskById.get(timing.taskId);
        const { x, y } = positions.get(task.id);
        const node = make('button', 'graph-node');
        node.type = 'button';
        node.title = taskNumber(task.id) + ' ' + task.name;
        node.classList.toggle('critical', timing.slack === 0);
        node.setAttribute('aria-pressed', 'false');
        node.style.left = x + 'px';
        node.style.top = y + 'px';
        node.style.width = NODE_WIDTH + 'px';
        node.style.height = NODE_HEIGHT + 'px';

        const meta = make('span', 'node-meta');
        meta.append(make('span', '', taskNumber(task.id)), make('span', '', formatter.format(task.duration) + '분'));
        node.append(make('span', 'node-title', task.name), meta);
        node.addEventListener('click', () => select(task.id));
        nodes.set(task.id, node);
        world.append(node);
    }

    // Long edges use rails above the cards so they can skip stages without crossing a node.
    const connections = [...schedule.edges].sort((a, b) => Number(a.critical) - Number(b.critical)).map((edge, index) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        return {
            ...edge,
            resource: resourceByEdge.has(edge.from + ':' + edge.to),
            x1: from.x + NODE_WIDTH,
            y1: from.y + NODE_HEIGHT / 2,
            x2: to.x,
            y2: to.y + NODE_HEIGHT / 2,
            rail: to.level - from.level > 1 ? PADDING + (index % 5) * 6 : null
        };
    });

    function draw() {
        frame = 0;
        if (!context) return;
        const pixelRatio = window.devicePixelRatio || 1;
        const canvasWidth = viewport.clientWidth;
        const canvasHeight = viewport.clientHeight;
        const deviceWidth = Math.round(canvasWidth * pixelRatio);
        const deviceHeight = Math.round(canvasHeight * pixelRatio);
        if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
            canvas.width = deviceWidth;
            canvas.height = deviceHeight;
            canvas.style.width = canvasWidth + 'px';
            canvas.style.height = canvasHeight + 'px';
        }

        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, deviceWidth, deviceHeight);
        context.setTransform(
            pixelRatio * scale, 0, 0, pixelRatio * scale,
            (offsetX - viewport.scrollLeft) * pixelRatio,
            (offsetY - viewport.scrollTop) * pixelRatio
        );

        for (const edge of connections) {
            const { x1, y1, x2, y2, rail } = edge;
            const color = edge.critical ? '#3153d7' : '#8999b6';
            context.globalAlpha = selected === null || edge.from === selected || edge.to === selected ? 1 : .26;
            context.strokeStyle = color;
            context.fillStyle = color;
            context.lineWidth = edge.critical ? 2.2 : 1.45;
            context.lineJoin = 'round';
            context.setLineDash(edge.resource ? [5, 4] : []);
            context.beginPath();
            context.moveTo(x1, y1);
            if (rail === null) {
                const midpoint = (x1 + x2) / 2;
                context.bezierCurveTo(midpoint, y1, midpoint, y2, x2 - 2, y2);
            } else {
                context.lineTo(x1 + 11, y1);
                context.lineTo(x1 + 11, rail);
                context.lineTo(x2 - 13, rail);
                context.lineTo(x2 - 13, y2);
                context.lineTo(x2 - 2, y2);
            }
            context.stroke();
            context.beginPath();
            context.moveTo(x2 - 1, y2);
            context.lineTo(x2 - 7, y2 - 3.5);
            context.lineTo(x2 - 7, y2 + 3.5);
            context.closePath();
            context.fill();
        }
        context.globalAlpha = 1;
    }

    function queueDraw() {
        if (frame === 0) frame = requestAnimationFrame(draw);
    }

    function applyScale(nextScale, center = false) {
        const centerX = (viewport.scrollLeft + viewport.clientWidth / 2 - offsetX) / scale;
        const centerY = (viewport.scrollTop + viewport.clientHeight / 2 - offsetY) / scale;
        scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextScale));
        offsetX = Math.max(0, Math.floor((viewport.clientWidth - width * scale) / 2));
        offsetY = Math.max(0, Math.floor((viewport.clientHeight - height * scale) / 2));
        surface.style.width = Math.max(viewport.clientWidth, Math.ceil(width * scale)) + 'px';
        surface.style.height = Math.max(viewport.clientHeight, Math.ceil(height * scale)) + 'px';
        world.style.left = offsetX + 'px';
        world.style.top = offsetY + 'px';
        world.style.transform = 'scale(' + scale + ')';
        if (center) {
            viewport.scrollLeft = centerX * scale + offsetX - viewport.clientWidth / 2;
            viewport.scrollTop = centerY * scale + offsetY - viewport.clientHeight / 2;
        } else if (autoFit) {
            viewport.scrollTo(0, 0);
        }
        zoomOut.disabled = scale <= MIN_ZOOM;
        zoomIn.disabled = scale >= MAX_ZOOM;
        queueDraw();
    }

    function fitScale() {
        return Math.min(1, viewport.clientWidth / width, viewport.clientHeight / height);
    }

    const events = new AbortController();
    const options = { signal: events.signal };
    const resize = new ResizeObserver(() => {
        applyScale(autoFit ? Math.max(.82, fitScale()) : scale);
    });
    zoomOut.addEventListener('click', () => {
        autoFit = false;
        applyScale(scale / 1.25, true);
    }, options);
    zoomIn.addEventListener('click', () => {
        autoFit = false;
        applyScale(scale * 1.25, true);
    }, options);
    zoomFit.addEventListener('click', () => {
        autoFit = false;
        applyScale(fitScale());
        viewport.scrollTo(0, 0);
    }, options);
    viewport.addEventListener('scroll', queueDraw, options);

    surface.append(canvas, world);
    viewport.replaceChildren(surface);
    updateDetail();
    applyScale(Math.max(.82, fitScale()));
    resize.observe(viewport);
    return () => {
        resize.disconnect();
        events.abort();
        cancelAnimationFrame(frame);
    };
}
