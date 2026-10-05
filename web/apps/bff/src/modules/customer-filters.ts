import type { CustomerListQuery } from '@leadops/types';
import type { Prisma } from '@prisma/client';

/** Listing and export must use exactly the same customer filters. */
export function customerWhere(query: CustomerListQuery): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = { is_deleted: false };
  if (query.q) {
    where.OR = [{ name: { contains: query.q } }, { huji_no: { contains: query.q } }];
  }
  if (query.address) where.address = { contains: query.address };
  if (query.province) where.province = { contains: query.province };
  if (query.city) where.city = { contains: query.city };
  if (query.district) where.district = { contains: query.district };
  if (query.gender) where.gender = query.gender;
  if (query.id_type) where.id_type = query.id_type;
  return where;
}
