import { FilterOperator } from './crud.types';

export const operatorMap: Record<string, FilterOperator> = {
  eq: FilterOperator.EQ,
  ne: FilterOperator.NE,
  lt: FilterOperator.LT,
  lte: FilterOperator.LTE,
  gt: FilterOperator.GT,
  gte: FilterOperator.GTE,
  like: FilterOperator.LIKE,
  in: FilterOperator.IN,
  between: FilterOperator.BETWEEN,
  isnull: FilterOperator.ISNULL,
  notnull: FilterOperator.NOTNULL,
};
