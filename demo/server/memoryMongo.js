export function createMemoryMongo(seed = {}) {
  const collections = new Map()

  for (const [name, rows] of Object.entries(seed)) {
    collections.set(name, new MemoryCollection(rows))
  }

  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection())
      return collections.get(name)
    }
  }
}

class MemoryCollection {
  #items

  constructor(items = []) {
    this.#items = items.map((item) => structuredClone(item))
  }

  async findOne(filter = {}) {
    return clone(this.#items.find((item) => matches(item, filter)) ?? null)
  }

  async updateOne(filter, update, options = {}) {
    let item = this.#items.find((row) => matches(row, filter))

    if (!item && options.upsert) {
      item = { _id: filter._id }
      this.#items.push(item)
    }

    if (item && update.$set) {
      for (const [path, value] of Object.entries(update.$set)) {
        setByPath(item, path, value)
      }
    }

    if (item && update.$unset) {
      for (const path of Object.keys(update.$unset)) {
        unsetByPath(item, path)
      }
    }

    return { acknowledged: true }
  }

  async insertOne(item) {
    this.#items.push(clone(item))
    return { insertedId: item._id }
  }

  async deleteOne(filter) {
    const before = this.#items.length
    this.#items = this.#items.filter((item) => !matches(item, filter))
    return { deletedCount: before - this.#items.length }
  }

  find(filter = {}) {
    let items = this.#items.filter((item) => matches(item, filter))

    return {
      sort(sort = {}) {
        const entries = Object.entries(sort)
        items = [...items].sort((a, b) => {
          for (const [field, dir] of entries) {
            const av = getByPath(a, field)
            const bv = getByPath(b, field)
            if (av === bv) continue
            return av < bv ? -1 * dir : 1 * dir
          }
          return 0
        })
        return this
      },
      limit(count) {
        if (count > 0) items = items.slice(0, count)
        return this
      },
      async toArray() {
        return items.map(clone)
      }
    }
  }
}

function matches(item, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    const value = getByPath(item, key)
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$gt" in expected && !(value > expected.$gt)) return false
      if ("$lte" in expected && !(value <= expected.$lte)) return false
      if ("$ne" in expected && value === expected.$ne) return false
      return true
    }
    return value === expected
  })
}

function setByPath(target, path, value) {
  const parts = String(path).split(".").filter(Boolean)
  let cursor = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor[parts[i]] ??= {}
    cursor = cursor[parts[i]]
  }
  cursor[parts[parts.length - 1]] = value
}

function getByPath(target, path) {
  let cursor = target
  for (const part of String(path).split(".").filter(Boolean)) {
    if (cursor == null) return undefined
    cursor = cursor[part]
  }
  return cursor
}

function unsetByPath(target, path) {
  const parts = String(path).split(".").filter(Boolean)
  let cursor = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor?.[parts[i]]
    if (!cursor) return
  }
  delete cursor[parts[parts.length - 1]]
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}
