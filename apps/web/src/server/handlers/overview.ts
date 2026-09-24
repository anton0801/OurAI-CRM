import { overviewEndpoints as E } from '@castlane/api-contracts';
import { getOverview } from '@castlane/application';
import { route } from '../http/router';

route(E.get, ({ ctx, input }) => getOverview(ctx, input.query));
