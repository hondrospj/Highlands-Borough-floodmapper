"""Prevent publishing a six-hour refresh before both data producers finish."""
import re
import unittest
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[1] / '.github' / 'workflows'


def block(text, name, indent=0):
    """Read an explicit mapping block from these dependency-free workflows."""
    lines = text.splitlines()
    header = re.compile(r'^' + ' ' * indent + re.escape(name) + r':\s*$')
    start = next(index for index, line in enumerate(lines) if header.match(line))
    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and not line.lstrip().startswith('#'):
            if len(line) - len(line.lstrip()) <= indent:
                break
        end += 1
    return '\n'.join(lines[start + 1:end])


def scalar(text, name, indent):
    match = re.search(r'^' + ' ' * indent + re.escape(name) + r':\s*(\S.*?)\s*$', text, re.MULTILINE)
    return match.group(1) if match else None


class CoordinatedRefreshTests(unittest.TestCase):
    def setUp(self):
        self.coordinator = (WORKFLOWS / 'refresh-six-hourly.yml').read_text()
        self.producers = {
            part: (WORKFLOWS / ('update-' + part + '.yml')).read_text()
            for part in ('observed', 'forecast')
        }
        self.publisher = (WORKFLOWS / 'publish-cupajoe.yml').read_text()

    def test_only_coordinator_schedules_the_mapper_refresh(self):
        trigger = block(self.coordinator, 'on')
        self.assertIn('cron: "25 2,8,14,20 * * *"', trigger)
        self.assertIn('workflow_dispatch:', trigger)
        for producer in self.producers.values():
            self.assertNotIn('schedule:', block(producer, 'on'))
            self.assertIn('workflow_dispatch:', block(producer, 'on'))

    def test_both_producers_must_succeed_before_publication(self):
        jobs = block(self.coordinator, 'jobs')
        observed = block(jobs, 'update-observed', 2)
        forecast = block(jobs, 'update-forecast', 2)
        publish = block(jobs, 'publish-fresh-data', 2)
        self.assertEqual(scalar(observed, 'uses', 4), './.github/workflows/update-observed.yml')
        self.assertEqual(scalar(forecast, 'uses', 4), './.github/workflows/update-forecast.yml')
        self.assertEqual(scalar(forecast, 'needs', 4), 'update-observed')
        self.assertEqual(scalar(publish, 'needs', 4), 'update-forecast')
        self.assertEqual(scalar(publish, 'uses', 4), './.github/workflows/publish-cupajoe.yml')
        self.assertNotIn('always()', forecast + publish)
        for job in (observed, forecast):
            self.assertEqual(scalar(block(job, 'with', 4), 'defer_publication', 6), 'true')

    def test_intermediate_refreshes_cannot_publish(self):
        for producer in self.producers.values():
            reusable = block(block(producer, 'on'), 'workflow_call', 2)
            option = block(block(reusable, 'inputs', 4), 'defer_publication', 6)
            self.assertEqual(scalar(option, 'type', 8), 'boolean')
            self.assertEqual(scalar(option, 'default', 8), 'false')
            publish = block(block(producer, 'jobs'), 'publish-fresh-data', 2)
            self.assertEqual(scalar(publish, 'if', 4), '${{ !inputs.defer_publication }}')
        trigger = block(self.publisher, 'on')
        self.assertNotIn('workflow_run:', trigger)
        self.assertNotIn('push:', trigger)
        for entry in ('workflow_dispatch:', 'workflow_call:'):
            self.assertIn(entry, trigger)

    def test_coordinator_does_not_hold_a_callee_lock(self):
        coordinator_group = scalar(block(self.coordinator, 'concurrency'), 'group', 2)
        self.assertIsNotNone(coordinator_group)
        for workflow in [*self.producers.values(), self.publisher]:
            self.assertNotEqual(coordinator_group, scalar(block(workflow, 'concurrency'), 'group', 2))
        self.assertEqual(scalar(block(self.coordinator, 'concurrency'), 'cancel-in-progress', 2), 'false')
