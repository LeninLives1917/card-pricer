// Page-level load — inherits user from layout.
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
  const { user } = await parent();
  return { user };
};
