import config from '@aztec-labs/foundation/eslint';
import { globalIgnores } from 'eslint/config';

export default [globalIgnores(['vendor/**']), ...config];
