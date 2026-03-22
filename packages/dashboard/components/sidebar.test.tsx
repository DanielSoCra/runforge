import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './sidebar';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

// Mock signOut action
vi.mock('@/actions/auth', () => ({
  signOut: vi.fn(),
}));

describe('Sidebar', () => {
  it('renders Issues between Runs and Repos per spec', () => {
    render(<Sidebar />);

    const links = screen.getAllByRole('link');
    const labels = links.map((link) => link.textContent);

    const runsIndex = labels.indexOf('Runs');
    const issuesIndex = labels.indexOf('Issues');
    const reposIndex = labels.indexOf('Repositories');

    expect(runsIndex).toBeGreaterThan(-1);
    expect(issuesIndex).toBeGreaterThan(-1);
    expect(reposIndex).toBeGreaterThan(-1);

    // Spec: "Issues" between "Runs" and "Repos"
    expect(issuesIndex).toBe(runsIndex + 1);
    expect(reposIndex).toBe(issuesIndex + 1);
  });
});
