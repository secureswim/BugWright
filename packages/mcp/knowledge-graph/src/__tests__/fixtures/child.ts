import { Base, Contract, helper as compute } from "./base.js";
export class Child extends Base implements Contract {
  run() {
    return compute();
  }
  again() {
    return this.run();
  }
}
export function caller() {
  return compute();
}
