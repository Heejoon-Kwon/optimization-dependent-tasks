package io.github.heejoonkwon.flowline;

import com.google.ortools.Loader;
import com.google.ortools.sat.CpModel;
import com.google.ortools.sat.CpSolver;
import com.google.ortools.sat.CpSolverStatus;
import com.google.ortools.sat.IntVar;
import com.google.ortools.sat.IntervalVar;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

import static io.github.heejoonkwon.flowline.TaskScheduler.*;

final class ResourceScheduler {
    private static final int MAX_RESOURCES = 100;
    private static final int MAX_CAPACITY = 100;
    private static final double SOLVER_TIME_SECONDS = 5.0;

    record Resource(int id, String name, int capacity) {}
    record ResourceLink(int from, int to, List<Integer> resourceIds) {}
    record Plan(long duration, long lowerBound, boolean optimal, List<Step> order, List<Timing> timings,
                List<Edge> edges, List<Integer> criticalPath, List<ResourceLink> resourceLinks) {}
    record Analysis(Schedule dependencies, Plan optimized) {}

    private record Pool(Resource resource, Map<Integer, Integer> demands) {}
    private record Placement(List<Step> order, long lowerBound) {}
    private record Lane(int number, long availableAt, int previousTask) {}
    private record Link(int from, int to) {}

    private final TaskScheduler dag = new TaskScheduler();

    Analysis schedule(List<Task> tasks, List<Resource> resources) {
        Schedule dependencies = dag.schedule(tasks);
        Map<Integer, Pool> pools = collectDemands(tasks, resources == null ? List.of() : resources);
        List<Pool> occupied = pools.values().stream().filter(pool -> !pool.demands().isEmpty()).toList();
        if (occupied.isEmpty()) {
            return new Analysis(dependencies, toPlan(dependencies, dependencies.parallelDuration(), List.of()));
        }

        Placement placement = solve(tasks, occupied, dependencies);
        Map<Link, Set<Integer>> resourceLinks = resourceLinks(occupied, placement.order());
        Map<Integer, List<Integer>> extraPrerequisites = new HashMap<>();
        for (Link link : resourceLinks.keySet()) {
            extraPrerequisites.computeIfAbsent(link.to(), ignored -> new ArrayList<>()).add(link.from());
        }

        List<Task> augmented = new ArrayList<>(tasks.size());
        for (Task task : tasks) {
            List<Integer> prerequisites = new ArrayList<>(task.prerequisites());
            List<Integer> added = extraPrerequisites.getOrDefault(task.id(), List.of());
            prerequisites.addAll(added.stream().filter(id -> !prerequisites.contains(id)).toList());
            augmented.add(new Task(task.id(), task.name(), task.duration(), prerequisites));
        }

        // Move work left while preserving the solver's resource-unit assignments.
        // The longest path of this graph then matches the returned schedule's duration.
        List<ResourceLink> links = new ArrayList<>();
        Map<Integer, Task> byId = new HashMap<>();
        tasks.forEach(task -> byId.put(task.id(), task));
        for (var entry : resourceLinks.entrySet()) {
            Link link = entry.getKey();
            if (!byId.get(link.to()).prerequisites().contains(link.from())) {
                links.add(new ResourceLink(link.from(), link.to(), List.copyOf(entry.getValue())));
            }
        }
        return new Analysis(dependencies, toPlan(dag.schedule(augmented), placement.lowerBound(), links));
    }

    private Map<Integer, Pool> collectDemands(List<Task> tasks, List<Resource> resources) {
        if (resources.size() > MAX_RESOURCES) {
            throw new IllegalArgumentException("자원은 최대 " + MAX_RESOURCES + "개까지 입력할 수 있습니다.");
        }
        Map<Integer, Pool> pools = new LinkedHashMap<>();
        for (Resource resource : resources) {
            if (resource == null || resource.id() < 1 || pools.containsKey(resource.id())) {
                throw new IllegalArgumentException("자원 번호는 서로 다른 양의 정수여야 합니다.");
            }
            if (resource.name() == null || resource.name().isBlank() || resource.name().length() > MAX_NAME_LENGTH) {
                throw new IllegalArgumentException("자원 #" + resource.id() + "의 이름을 1~" + MAX_NAME_LENGTH + "자로 입력하세요.");
            }
            if (resource.capacity() < 1 || resource.capacity() > MAX_CAPACITY) {
                throw new IllegalArgumentException("자원 #" + resource.id() + "의 수량을 1~" + MAX_CAPACITY + "개 사이의 정수로 입력하세요.");
            }
            pools.put(resource.id(), new Pool(resource, new HashMap<>()));
        }
        for (Task task : tasks) {
            for (Demand demand : task.demands()) {
                Pool pool = demand == null ? null : pools.get(demand.resourceId());
                if (pool == null) {
                    throw new IllegalArgumentException("작업 #" + task.id() + "에 존재하지 않는 자원 번호가 있습니다.");
                }
                if (demand.quantity() < 1 || demand.quantity() > pool.resource().capacity()) {
                    throw new IllegalArgumentException("작업 #" + task.id() + "의 자원 #" + demand.resourceId() + " 사용량이 범위를 벗어났습니다.");
                }
                if (pool.demands().putIfAbsent(task.id(), demand.quantity()) != null) {
                    throw new IllegalArgumentException("작업 #" + task.id() + "에 자원 #" + demand.resourceId() + "이 중복되었습니다.");
                }
            }
        }
        return pools;
    }

    private Placement solve(List<Task> tasks, List<Pool> pools, Schedule baseline) {
        Loader.loadNativeLibraries();
        CpModel model = new CpModel();
        long horizon = baseline.serialDuration();
        long lowerBound = baseline.parallelDuration();
        Map<Integer, IntVar> starts = new HashMap<>();
        Map<Integer, IntVar> ends = new HashMap<>();
        Map<Integer, IntervalVar> intervals = new HashMap<>();
        Map<Integer, Integer> durations = new HashMap<>();
        for (Task task : tasks) {
            String suffix = "_" + task.id();
            IntVar start = model.newIntVar(0, horizon - task.duration(), "start" + suffix);
            IntVar end = model.newIntVar(task.duration(), horizon, "end" + suffix);
            starts.put(task.id(), start);
            ends.put(task.id(), end);
            intervals.put(task.id(), model.newIntervalVar(start, model.newConstant(task.duration()), end, "task" + suffix));
            durations.put(task.id(), task.duration());
        }
        for (Task task : tasks) {
            for (int prerequisite : task.prerequisites()) {
                model.addLessOrEqual(ends.get(prerequisite), starts.get(task.id()));
            }
        }
        for (Pool pool : pools) {
            int capacity = pool.resource().capacity();
            var cumulative = model.addCumulative(capacity);
            long workload = 0;
            for (var entry : pool.demands().entrySet()) {
                int id = entry.getKey();
                int quantity = entry.getValue();
                cumulative.addDemand(intervals.get(id), quantity);
                workload += (long) durations.get(id) * quantity;
            }
            lowerBound = Math.max(lowerBound, (workload + capacity - 1) / capacity);
        }

        IntVar makespan = model.newIntVar(lowerBound, horizon, "completion");
        model.addMaxEquality(makespan, ends.values().toArray(IntVar[]::new));
        model.minimize(makespan);
        for (Step step : baseline.serialOrder()) {
            model.addHint(starts.get(step.taskId()), step.start());
            model.addHint(ends.get(step.taskId()), step.finish());
        }
        model.addHint(makespan, horizon);

        CpSolver solver = new CpSolver();
        solver.getParameters().setMaxTimeInSeconds(SOLVER_TIME_SECONDS).setNumSearchWorkers(2);
        CpSolverStatus status = solver.solve(model);
        if (status == CpSolverStatus.UNKNOWN) {
            // The precedence-respecting serial order is a feasible fallback.
            return new Placement(baseline.serialOrder(), lowerBound);
        }
        if (status != CpSolverStatus.OPTIMAL && status != CpSolverStatus.FEASIBLE) {
            throw new IllegalStateException("Unexpected CP-SAT status: " + status);
        }

        List<Step> order = tasks.stream()
                .map(task -> new Step(task.id(), solver.value(starts.get(task.id())), solver.value(ends.get(task.id()))))
                .sorted(stepOrder())
                .toList();
        long solverBound = status == CpSolverStatus.OPTIMAL
                ? Math.round(solver.objectiveValue())
                : (long) Math.ceil(solver.bestObjectiveBound());
        return new Placement(order, Math.max(lowerBound, solverBound));
    }

    private Map<Link, Set<Integer>> resourceLinks(List<Pool> pools, List<Step> order) {
        Map<Link, Set<Integer>> links = new LinkedHashMap<>();
        for (Pool pool : pools) {
            PriorityQueue<Lane> lanes = new PriorityQueue<>(Comparator.comparingLong(Lane::availableAt)
                    .thenComparingInt(Lane::number));
            for (int i = 0; i < pool.resource().capacity(); i++) {
                lanes.add(new Lane(i, 0, 0));
            }
            for (Step step : order) {
                int quantity = pool.demands().getOrDefault(step.taskId(), 0);
                for (int i = 0; i < quantity; i++) {
                    Lane lane = lanes.remove();
                    if (lane.availableAt() > step.start()) {
                        throw new IllegalStateException("Schedule exceeds capacity for resource " + pool.resource().id());
                    }
                    if (lane.previousTask() != 0) {
                        Link link = new Link(lane.previousTask(), step.taskId());
                        links.computeIfAbsent(link, ignored -> new LinkedHashSet<>()).add(pool.resource().id());
                    }
                    lanes.add(new Lane(lane.number(), step.finish(), step.taskId()));
                }
            }
        }
        return links;
    }

    private Plan toPlan(Schedule schedule, long lowerBound, List<ResourceLink> links) {
        List<Step> order = schedule.timings().stream()
                .map(timing -> new Step(timing.taskId(), timing.earliestStart(), timing.earliestFinish()))
                .sorted(stepOrder())
                .toList();
        long duration = schedule.parallelDuration();
        if (duration < lowerBound) {
            throw new IllegalStateException("Schedule is below its lower bound");
        }
        return new Plan(duration, lowerBound, duration == lowerBound, order, schedule.timings(),
                schedule.edges(), schedule.criticalPath(), links);
    }

    private Comparator<Step> stepOrder() {
        return Comparator.comparingLong(Step::start).thenComparingInt(Step::taskId);
    }
}
