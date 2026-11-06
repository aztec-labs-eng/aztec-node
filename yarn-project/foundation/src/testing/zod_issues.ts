import type { z } from 'zod';

/**
 * Counts the issues in a zod error, including the ones nested under union branches. Used to check that rejecting a
 * large malformed input does not build one issue per element.
 */
export function countZodIssues(issues: readonly z.core.$ZodIssue[]): number {
  let count = 0;
  for (const issue of issues) {
    count++;
    if (issue.code === 'invalid_union') {
      for (const branch of issue.errors) {
        count += countZodIssues(branch);
      }
    }
  }
  return count;
}
