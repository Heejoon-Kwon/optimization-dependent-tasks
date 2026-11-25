package io.github.heejoonkwon.flowline;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static io.github.heejoonkwon.flowline.ResourceScheduler.Resource;
import static io.github.heejoonkwon.flowline.TaskScheduler.*;
import static org.junit.jupiter.api.Assertions.*;

class ResourceSchedulerTest {
    private final ResourceScheduler scheduler = new ResourceScheduler();

    @Test
    void staffingChangesTheOptimumWhileAutomaticWorkOverlaps() {
        var tasks = List.of(
                task(1, 1, List.of(), new Demand(1, 1)),
                task(2, 8, List.of(1), new Demand(2, 1)),
                task(3, 4, List.of(), new Demand(1, 1)),
                task(4, 6, List.of(), new Demand(1, 1)),
                task(5, 2, List.of(2, 3, 4), new Demand(1, 1), new Demand(2, 1)));

        for (int workers = 1; workers <= 2; workers++) {
            var resources = List.of(new Resource(1, "작업자", workers), new Resource(2, "커피 머신", 1));
            var analysis = scheduler.schedule(tasks, resources);
            assertEquals(11, analysis.dependencies().parallelDuration());
            assertEquals(List.of(1, 2, 5), analysis.dependencies().criticalPath());
            assertOptimal(analysis.optimized(), tasks, resources, workers == 1 ? 13 : 11);
            if (workers == 1) {
                assertTrue(analysis.optimized().resourceLinks().stream().anyMatch(link -> link.resourceIds().contains(1)));
            }
        }
    }

    @Test
    void optimizerCanWaitForUrgentWorkInsteadOfStartingAnAvailableJob() {
        var tasks = List.of(
                task(1, 1, List.of()),
                task(2, 10, List.of(), new Demand(1, 1)),
                task(3, 1, List.of(1), new Demand(1, 1)),
                task(4, 20, List.of(3)));
        var resources = List.of(new Resource(1, "작업자", 1));

        var plan = scheduler.schedule(tasks, resources).optimized();
        assertOptimal(plan, tasks, resources, 22);
        assertTrue(plan.order().contains(new Step(3, 1, 2)));
        assertTrue(plan.order().contains(new Step(4, 2, 22)));
    }

    @Test
    void accountsForConcurrentUseOfMultipleUnitsAndSimultaneousResourceDemands() {
        var tasks = List.of(
                task(9, 5, List.of(), new Demand(8, 2), new Demand(4, 1)),
                task(1, 4, List.of(), new Demand(8, 1)),
                task(6, 4, List.of(), new Demand(4, 1)),
                task(2, 3, List.of(1)));
        var resources = List.of(new Resource(8, "기계", 3), new Resource(4, "작업자", 1));

        assertOptimal(scheduler.schedule(tasks, resources).optimized(), tasks, resources, 9);
    }

    @Test
    void handlesAnEmptyResourceListAndRejectsUnresolvedOrOversizedDemands() {
        var freeTasks = List.of(task(1, 3, List.of()), task(2, 5, List.of()));
        assertOptimal(scheduler.schedule(freeTasks, List.of()).optimized(), freeTasks, List.of(), 5);
        var resources = List.of(new Resource(1, "작업자", 1));
        var invalidTasks = List.of(task(1, 2, List.of(), new Demand(2, 1)),
                task(1, 2, List.of(), new Demand(1, 2)),
                task(1, 2, List.of(), new Demand(1, 1), new Demand(1, 1)));
        for (Task invalid : invalidTasks) {
            assertThrows(IllegalArgumentException.class, () -> scheduler.schedule(List.of(invalid), resources));
        }
    }

    private void assertOptimal(ResourceScheduler.Plan plan, List<Task> tasks, List<Resource> resources, long expected) {
        assertEquals(expected, plan.duration());
        assertEquals(expected, plan.lowerBound());
        assertTrue(plan.optimal());
        Map<Integer, Step> steps = plan.order().stream().collect(Collectors.toMap(Step::taskId, Function.identity()));
        long pathDuration = tasks.stream().filter(task -> plan.criticalPath().contains(task.id())).mapToLong(Task::duration).sum();
        assertEquals(expected, pathDuration);
        for (Task task : tasks) {
            Step step = steps.get(task.id());
            assertEquals(task.duration(), step.finish() - step.start());
            for (int prerequisite : task.prerequisites()) {
                assertTrue(steps.get(prerequisite).finish() <= step.start());
            }
        }
        for (Resource resource : resources) {
            for (Step event : plan.order()) {
                int occupiedAtStart = tasks.stream().filter(task -> {
                    Step step = steps.get(task.id());
                    return step.start() <= event.start() && event.start() < step.finish();
                }).flatMap(task -> task.demands().stream()).filter(demand -> demand.resourceId() == resource.id())
                        .mapToInt(Demand::quantity).sum();
                assertTrue(occupiedAtStart <= resource.capacity());
            }
        }
    }

    private Task task(int id, int duration, List<Integer> prerequisites, Demand... demands) {
        return new Task(id, "작업 " + id, duration, prerequisites, List.of(demands));
    }
}
