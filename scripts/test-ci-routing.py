"""Keep fleet scheduling in the one directly routed workflow ci.yml calls."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / '.github/workflows'
TEXTS = {path.name: path.read_text() for path in sorted(WORKFLOWS.glob('*.y*ml'))}


class RoutingPolicyTests(unittest.TestCase):
    def test_ci_calls_fleet_at_an_immutable_commit(self):
        calls = re.findall(r'^\s+uses: (\S+)', TEXTS['ci.yml'], re.M)
        reusable = [call for call in calls if '/.github/workflows/' in call]
        self.assertEqual(len(reusable), 1, reusable)
        self.assertRegex(reusable[0], r'^esaueng/OpenFEA/\.github/workflows/fleet-ci\.yml@[0-9a-f]{40}$')

    def test_every_reusable_workflow_has_a_caller(self):
        # An uncalled workflow_call file still looks like enforced policy.
        callers = '\n'.join(TEXTS.values())
        for name, text in TEXTS.items():
            if re.search(r'^\s+workflow_call:', text, re.M):
                with self.subTest(workflow=name):
                    self.assertRegex(callers, rf'uses: \S*/\.github/workflows/{re.escape(name)}@')

    def test_only_fleet_ci_schedules_on_the_trusted_fleet(self):
        for name, text in TEXTS.items():
            if name == 'fleet-ci.yml':
                continue
            with self.subTest(workflow=name):
                self.assertNotIn('ci-trusted-main', text)
                self.assertNotIn('self-hosted', text)
                self.assertNotRegex(text, r'ci-server-(jane|john)')

    def test_no_hosted_routing_job(self):
        # Retired: an ubuntu-latest authorize job plus remus select-runner in
        # front of the fleet. Routing is now the runs-on expression alone.
        for name, text in TEXTS.items():
            with self.subTest(workflow=name):
                self.assertNotIn('select-runner.yml', text)
                self.assertNotIn('/routing/v1/target', text)


if __name__ == '__main__':
    unittest.main()
