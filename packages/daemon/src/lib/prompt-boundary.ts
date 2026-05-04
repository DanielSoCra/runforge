export interface UserIssueContent {
  issueNumber?: number;
  title: string;
  body: string;
}

export function formatUserIssueContent(content: UserIssueContent): string {
  const lines = ['<user-issue-content>'];
  if (content.issueNumber !== undefined) {
    lines.push(`<issue-number>${content.issueNumber}</issue-number>`);
  }
  lines.push(
    '<title>',
    escapePromptBoundaryText(content.title),
    '</title>',
    '<body>',
    escapePromptBoundaryText(content.body),
    '</body>',
    '</user-issue-content>',
  );
  return lines.join('\n');
}

export function escapePromptBoundaryText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
