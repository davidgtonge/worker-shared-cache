// check.sh expects this to fail to compile, proving the checks can catch a mistake: get() may miss.
import { openCache } from 'worker-shared-cache'
export const n: number = openCache('x', 1).get('k')
