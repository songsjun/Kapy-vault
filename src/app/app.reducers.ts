import { MetaReducer } from '@ngrx/store'

export interface State {}
export const reducers = {}
// Actions and state can contain wallet material. Never send them to the console.
export const metaReducers: MetaReducer<State>[] = []
