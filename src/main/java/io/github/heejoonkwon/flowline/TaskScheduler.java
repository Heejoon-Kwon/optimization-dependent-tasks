package io.github.heejoonkwon.flowline;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.stream.Collectors;

final class TaskScheduler {
    static final int MAX_TASKS = 100;
    static final int MAX_DURATION = 1_000_000;
    static final int MAX_NAME_LENGTH = 80;

    record Task(int id, String name, int duration, List<Integer> prerequisites) {}
    record Step(int taskId, long start, long finish) {}
    record Timing(int taskId, int level, long earliestStart, long earliestFinish, long slack) {}
    record Edge(int from, int to, boolean critical) {}
    record Schedule(long serialDuration, long parallelDuration, List<Integer> criticalPath,
                    List<Step> serialOrder, List<Timing> timings, List<Edge> edges) {}

    Schedule schedule(List<Task> tasks) {
        Map<Integer, Integer> indices = validateTasks(tasks);
        int count = tasks.size();
        List<List<Integer>> successors = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            successors.add(new ArrayList<>());
        }

        int[] indegree = new int[count];
        for (int to = 0; to < count; to++) {
            Task task = tasks.get(to);
            List<Integer> prerequisites = task.prerequisites();
            if (prerequisites == null) {
                throw new IllegalArgumentException("#" + task.id() + "의 선행 작업 목록이 필요합니다.");
            }
            Set<Integer> seen = new HashSet<>();
            for (Integer id : prerequisites) {
                Integer from = indices.get(id);
                if (from == null) {
                    throw new IllegalArgumentException("#" + task.id() + "에 존재하지 않는 선행 작업 번호가 있습니다.");
                }
                if (from == to) {
                    throw new IllegalArgumentException("#" + task.id() + "는 자기 자신을 선행 작업으로 지정할 수 없습니다.");
                }
                if (!seen.add(id)) {
                    throw new IllegalArgumentException("#" + task.id() + "의 선행 작업 #" + id + "가 중복되었습니다.");
                }
                successors.get(from).add(to);
                indegree[to]++;
            }
        }

        long[] earliestStart = new long[count];
        long[] earliestFinish = new long[count];
        int[] level = new int[count];
        int[] remainingParents = indegree.clone();
        List<Integer> topological = new ArrayList<>(count);
        ArrayDeque<Integer> ready = new ArrayDeque<>();
        for (int i = 0; i < count; i++) {
            if (remainingParents[i] == 0) {
                ready.add(i);
            }
        }

        long parallelDuration = 0;
        while (!ready.isEmpty()) {
            int from = ready.remove();
            topological.add(from);
            earliestFinish[from] = earliestStart[from] + tasks.get(from).duration();
            parallelDuration = Math.max(parallelDuration, earliestFinish[from]);
            for (int to : successors.get(from)) {
                earliestStart[to] = Math.max(earliestStart[to], earliestFinish[from]);
                level[to] = Math.max(level[to], level[from] + 1);
                if (--remainingParents[to] == 0) {
                    ready.add(to);
                }
            }
        }
        if (topological.size() != count) {
            throw cycleError(tasks, successors);
        }

        // Longest remaining duration from each task, including the task itself.
        long[] remaining = new long[count];
        for (int i = topological.size() - 1; i >= 0; i--) {
            int from = topological.get(i);
            long longestSuccessor = 0;
            for (int to : successors.get(from)) {
                longestSuccessor = Math.max(longestSuccessor, remaining[to]);
            }
            remaining[from] = tasks.get(from).duration() + longestSuccessor;
        }

        Comparator<Integer> priority = Comparator.<Integer>comparingLong(i -> remaining[i]).reversed()
                .thenComparingInt(i -> tasks.get(i).id());
        PriorityQueue<Integer> available = new PriorityQueue<>(priority);
        for (int i = 0; i < count; i++) {
            if (indegree[i] == 0) {
                available.add(i);
            }
        }

        List<Integer> criticalPath = new ArrayList<>();
        Integer current = available.peek();
        while (current != null) {
            criticalPath.add(tasks.get(current).id());
            current = successors.get(current).stream().min(priority).orElse(null);
        }

        List<Step> serialOrder = new ArrayList<>(count);
        long serialDuration = 0;
        while (!available.isEmpty()) {
            int from = available.remove();
            Task task = tasks.get(from);
            long finish = serialDuration + task.duration();
            serialOrder.add(new Step(task.id(), serialDuration, finish));
            serialDuration = finish;
            for (int to : successors.get(from)) {
                if (--indegree[to] == 0) {
                    available.add(to);
                }
            }
        }

        List<Timing> timings = new ArrayList<>(count);
        List<Edge> edges = new ArrayList<>();
        for (int from = 0; from < count; from++) {
            long slack = parallelDuration - earliestStart[from] - remaining[from];
            timings.add(new Timing(tasks.get(from).id(), level[from], earliestStart[from], earliestFinish[from], slack));
            for (int to : successors.get(from)) {
                boolean critical = slack == 0
                        && earliestFinish[from] == earliestStart[to]
                        && earliestStart[to] + remaining[to] == parallelDuration;
                edges.add(new Edge(tasks.get(from).id(), tasks.get(to).id(), critical));
            }
        }
        return new Schedule(serialDuration, parallelDuration, criticalPath, serialOrder, timings, edges);
    }

    private Map<Integer, Integer> validateTasks(List<Task> tasks) {
        if (tasks == null || tasks.isEmpty() || tasks.size() > MAX_TASKS) {
            throw new IllegalArgumentException("작업을 1개 이상 " + MAX_TASKS + "개 이하로 입력하세요.");
        }
        Map<Integer, Integer> indices = new HashMap<>();
        for (int i = 0; i < tasks.size(); i++) {
            Task task = tasks.get(i);
            if (task == null || task.id() < 1 || indices.putIfAbsent(task.id(), i) != null) {
                throw new IllegalArgumentException("작업 번호는 서로 다른 양의 정수여야 합니다.");
            }
            String name = task.name();
            if (name == null || name.isBlank() || name.length() > MAX_NAME_LENGTH) {
                throw new IllegalArgumentException("#" + task.id() + "의 작업 이름을 1~" + MAX_NAME_LENGTH + "자로 입력하세요.");
            }
            if (task.duration() < 1 || task.duration() > MAX_DURATION) {
                throw new IllegalArgumentException("#" + task.id() + "의 소요 시간을 1~" + MAX_DURATION + "분 사이의 정수로 입력하세요.");
            }
        }
        return indices;
    }

    private IllegalArgumentException cycleError(List<Task> tasks, List<List<Integer>> successors) {
        int[] state = new int[tasks.size()];
        int[] parent = new int[tasks.size()];
        for (int start = 0; start < tasks.size(); start++) {
            if (state[start] == 0) {
                List<Integer> cycle = findCycle(start, successors, state, parent);
                if (!cycle.isEmpty()) {
                    String chain = cycle.stream().map(i -> "#" + tasks.get(i).id())
                            .collect(Collectors.joining(" → "));
                    return new IllegalArgumentException("선행 작업이 순환합니다. 연결을 수정하세요. " + chain);
                }
            }
        }
        throw new IllegalStateException("Kahn's algorithm detected a cycle, but no cycle was found.");
    }

    private List<Integer> findCycle(int from, List<List<Integer>> successors, int[] state, int[] parent) {
        state[from] = 1;
        for (int to : successors.get(from)) {
            if (state[to] == 1) {
                List<Integer> cycle = new ArrayList<>();
                for (int vertex = from; vertex != to; vertex = parent[vertex]) {
                    cycle.add(vertex);
                }
                cycle.add(to);
                Collections.reverse(cycle);
                cycle.add(to);
                return cycle;
            }
            if (state[to] == 0) {
                parent[to] = from;
                List<Integer> cycle = findCycle(to, successors, state, parent);
                if (!cycle.isEmpty()) {
                    return cycle;
                }
            }
        }
        state[from] = 2;
        return List.of();
    }
}
