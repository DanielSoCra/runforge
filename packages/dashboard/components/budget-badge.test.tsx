import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BudgetBadge, getBudgetStatus } from './budget-badge';

describe('getBudgetStatus', () => {
  it('returns ok when no budget limit', () => {
    expect(getBudgetStatus(5, null)).toBe('ok');
  });

  it('returns ok when budget limit is zero', () => {
    expect(getBudgetStatus(5, 0)).toBe('ok');
  });

  it('returns ok when cost is under 80%', () => {
    expect(getBudgetStatus(7.9, 10)).toBe('ok');
  });

  it('returns warning at exactly 80%', () => {
    expect(getBudgetStatus(8, 10)).toBe('warning');
  });

  it('returns warning between 80% and 100%', () => {
    expect(getBudgetStatus(9.5, 10)).toBe('warning');
  });

  it('returns exceeded at exactly 100%', () => {
    expect(getBudgetStatus(10, 10)).toBe('exceeded');
  });

  it('returns exceeded above 100%', () => {
    expect(getBudgetStatus(15, 10)).toBe('exceeded');
  });
});

describe('BudgetBadge', () => {
  it('renders nothing when no budget limit (#84)', () => {
    const { container } = render(<BudgetBadge totalCost={5} budgetLimit={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when under 80% (#84)', () => {
    const { container } = render(<BudgetBadge totalCost={7} budgetLimit={10} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders warning badge at 80%+ (#84)', () => {
    render(<BudgetBadge totalCost={8.5} budgetLimit={10} />);
    expect(screen.getByText('80%+ budget')).toBeInTheDocument();
  });

  it('renders exceeded badge at 100%+ (#84)', () => {
    render(<BudgetBadge totalCost={12} budgetLimit={10} />);
    expect(screen.getByText('Over budget')).toBeInTheDocument();
  });
});
