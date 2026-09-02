import { FetchQuery, Order, Where } from './crud.types';

export const buildFindManyArgs = (query: FetchQuery): any => {
  const { page = 1, limit = 10, select, orderBy, where } = query;

  const args: any = {
    skip: (page - 1) * limit,
    take: limit,
  };

  if (select?.length) {
    args.select = select.reduce((acc: Record<string, boolean>, field: string) => {
      acc[field] = true;
      return acc;
    }, {});
  }

  if (orderBy?.length) {
    args.orderBy = orderBy.map((o: Order) => ({
      [o.column]: o.direction?.toLowerCase() ?? 'asc',
    }));
  }

  if (where?.length) {
    args.where = buildWhere(where);
  }

  return args;
};

const buildWhere = (groups: Where[][]): any => {
  const andConditions = groups
    .filter((group) => group.length > 0)
    .map((group) => {
      if (group.length === 1) {
        return mapCondition(group[0]);
      }

      return {
        OR: group.map(mapCondition),
      };
    });

  if (andConditions.length === 0) {
    return {};
  }

  if (andConditions.length === 1) {
    return andConditions[0];
  }

  return {
    AND: andConditions,
  };
};

const mapCondition = (condition: Where): any => {
  const { column, operator, value } = condition;

  const nested = (field: string, filter: any): Record<string, any> => {
    const result: Record<string, any> = {};
    const parts = field.split('.');

    let current = result;

    for (let i = 0; i < parts.length - 1; i++) {
      current[parts[i]] = {};
      current = current[parts[i]];
    }

    current[parts[parts.length - 1]] = filter;

    return result;
  };

  switch (operator) {
    case 'eq':
      return nested(column, { equals: value });

    case 'ne':
      return nested(column, { not: value });

    case 'gt':
      return nested(column, { gt: value });

    case 'gte':
      return nested(column, { gte: value });

    case 'lt':
      return nested(column, { lt: value });

    case 'lte':
      return nested(column, { lte: value });

    case 'like':
      return nested(column, {
        contains: value,
      });

    case 'in':
      if (!Array.isArray(value)) {
        throw new Error('IN requires an array value');
      }

      return nested(column, {
        in: value,
      });

    case 'between':
      if (!Array.isArray(value) || value.length !== 2) {
        throw new Error('BETWEEN requires exactly two values');
      }

      return nested(column, {
        gte: value[0],
        lte: value[1],
      });

    case 'isnull':
      return nested(column, null);

    case 'notnull':
      return nested(column, {
        not: null,
      });

    default:
      return nested(column, {
        equals: value,
      });
  }
};
