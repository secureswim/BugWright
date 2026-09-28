export const LIMIT = 3;
export interface Contract {
  run(): number;
}
export class Base {
  base() {
    return LIMIT;
  }
}
export function helper() {
  return LIMIT;
}
