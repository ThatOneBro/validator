import type { Handler, Context } from 'hono'
import { JSONPath } from 'jsonpath-plus'
import validator from './validator'
export type Validator = typeof validator

type Param = string | number | Record<string, string | number> | Message
type Rule = Function | [Function, ...Param[]]
type Rules = Rule | Rule[]
type Done = (resultSet: ResultSet, context: Context) => Response | undefined

type RuleSet = {
  body?: Record<string, Rules>
  json?: Record<string, Rules>
  header?: Record<string, Rules>
  query?: Record<string, Rules>
  done?: Done
}

type ResultSet = {
  hasError: boolean
  messages: string[]
  errors: Result[]
}

type Result = {
  rule: Function
  params: Param[]
  message?: string
}

class Message {
  value: string
  constructor(value: string) {
    this.value = value
  }
  getMessage(): string {
    return this.value
  }
}

const message = (value: string): Message => {
  return new Message(value)
}

const validatorMiddleware = (
  validatorFunction: (validator: Validator, message: (value: string) => Message) => RuleSet
): Handler => {
  return async (c, next) => {
    const validations = validatorFunction(validator, message)

    const result: ResultSet = {
      hasError: false,
      messages: [],
      errors: [],
    }

    const v = validations

    const validate = (rules: Rules, value: string, messageFunc: (ruleName: string) => string) => {
      value ||= ''

      let count = 0
      const results: Result[] = []

      const check = (rules: Rules) => {
        if (!Array.isArray(rules)) {
          if (rules instanceof Message) {
            if (results[count - 1]) {
              results[count - 1].message = rules.getMessage()
            }
          } else if (typeof rules === 'function') {
            results[count] = {
              rule: rules,
              params: [],
            }
            count++
          } else {
            results[count - 1].params.push(rules)
          }
        } else {
          for (const rule of rules) {
            check(rule as Rules)
          }
        }
      }
      check(rules)

      let invalid = false
      results.map((r) => {
        const ok = r.rule(value, ...r.params)
        if (!invalid && ok === false) {
          invalid = true
          result.errors.push(r)
          if (r.message) {
            result.messages.push(r.message)
          } else {
            result.messages.push(messageFunc(r.rule.name))
          }
        }
        if (typeof ok !== 'boolean') {
          // ok is sanitized string
          value = ok
        }
      })

      if (invalid) {
        result.hasError = true
        return
      }
    }

    if (v.query) {
      const query = v.query
      Object.keys(query).map((key) => {
        const value = c.req.query(key)
        const message = (name: string) =>
          `Invalid Value: the query parameter "${key}" is invalid - ${name}`
        validate(query[key], value, message)
      })
    }

    if (v.header) {
      const header = v.header
      Object.keys(header).map((key) => {
        const value = c.req.headers.get(key) || ''
        const message = (name: string) =>
          `Invalid Value: the request header "${key}" is invalid - ${name}`
        validate(header[key], value, message)
      })
    }

    if (v.body) {
      const field = v.body
      const parsedBody = (await c.req.parseBody()) as Record<string, string>
      Object.keys(field).map(async (key) => {
        const value = parsedBody[key]
        const message = (name: string) =>
          `Invalid Value: the request body "${key}" is invalid - ${name}`
        validate(field[key], value, message)
      })
    }

    if (v.json) {
      const field = v.json
      const json = (await c.req.json()) as object
      Object.keys(field).map(async (key) => {
        const data = JSONPath({ path: key, json })
        const value = `${data[0]}` // Force converting to string
        const message = (name: string) =>
          `Invalid Value: the JSON body "${key}" is invalid - ${name}`
        validate(field[key], value, message)
      })
    }

    if (v.done) {
      const res = v.done(result, c)
      if (res) {
        return res
      }
    }

    if (result.hasError) {
      return c.text(result.messages.join('\n'), 400)
    }
    await next()
  }
}

export { validatorMiddleware as validation }
