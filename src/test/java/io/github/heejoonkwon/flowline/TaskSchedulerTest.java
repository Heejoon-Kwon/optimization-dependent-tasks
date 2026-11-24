package io.github.heejoonkwon.flowline;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TaskSchedulerTest {
    private final TaskScheduler scheduler = new TaskScheduler();

    @Test
    void schedulesOutOfOrderIdsAcrossBranchesAndAJoin() {
        var result = scheduler.schedule(List.of(
                task(18, 2, 4, 7), task(7, 4), task(4, 5, 10), task(10, 3), task(2, 1)));

        assertEquals(15, result.serialDuration());
        assertEquals(10, result.parallelDuration());
        assertEquals(List.of(10, 4, 18), result.criticalPath());
        assertEquals(List.of(
                new TaskScheduler.Step(10, 0, 3), new TaskScheduler.Step(4, 3, 8),
                new TaskScheduler.Step(7, 8, 12), new TaskScheduler.Step(18, 12, 14),
                new TaskScheduler.Step(2, 14, 15)), result.serialOrder());
        assertEquals(new TaskScheduler.Timing(18, 2, 8, 10, 0), result.timings().get(0));
        assertEquals(new TaskScheduler.Timing(7, 0, 0, 4, 4), result.timings().get(1));
    }

    @Test
    void marksBothTiedPathsAndExcludesAnEdgeBetweenCriticalNodesThatSkipsTheBottleneck() {
        var result = scheduler.schedule(List.of(
                task(1, 2), task(2, 3, 1), task(3, 3, 1), task(4, 1, 1, 2, 3)));

        assertEquals(6, result.parallelDuration());
        assertEquals(List.of(1, 2, 4), result.criticalPath());
        assertTrue(result.timings().stream().allMatch(timing -> timing.slack() == 0));
        assertEquals(List.of(
                new TaskScheduler.Edge(1, 2, true), new TaskScheduler.Edge(1, 3, true),
                new TaskScheduler.Edge(1, 4, false), new TaskScheduler.Edge(2, 4, true),
                new TaskScheduler.Edge(3, 4, true)), result.edges());
    }

    @Test
    void usesLowestIdToBreakTiesBetweenIndependentTasks() {
        var result = scheduler.schedule(List.of(task(4, 3), task(1, 3), task(9, 2)));

        assertEquals(3, result.parallelDuration());
        assertEquals(8, result.serialDuration());
        assertEquals(List.of(1), result.criticalPath());
        assertEquals(List.of(1, 4, 9), result.serialOrder().stream().map(TaskScheduler.Step::taskId).toList());
    }

    @Test
    void reportsTheActualCycleEvenWithDownstreamTasksAndAnIndependentRoot() {
        var error = assertThrows(IllegalArgumentException.class, () -> scheduler.schedule(List.of(
                task(1, 1, 4), task(2, 1), task(3, 1, 5), task(4, 1, 3), task(5, 1, 4))));

        assertTrue(error.getMessage().contains("#3 → #4 → #5 → #3"));
    }

    @Test
    void validatesTaskFieldsAndPrerequisites() {
        for (var tasks : List.of(
                List.of(task(1, 0)),
                List.of(task(1, 2, 1)),
                List.of(task(1, 2, 9)),
                List.of(task(1, 2), task(2, 2, 1, 1)),
                List.of(task(1, 2), task(1, 4)),
                List.of(new TaskScheduler.Task(1, "  ", 1, List.of())))) {
            assertThrows(IllegalArgumentException.class, () -> scheduler.schedule(tasks));
        }
    }

    private TaskScheduler.Task task(int id, int duration, Integer... prerequisites) {
        return new TaskScheduler.Task(id, "작업 " + id, duration, List.of(prerequisites));
    }
}
