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

  async countDocuments(filter = {}) {
    return this.#items.filter((item) => matches(item, filter)).length
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
      skip(count) {
        if (count > 0) items = items.slice(count)
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

// Подмножество фильтров Mongo, которое строит сама библиотека: условие права
// она кладёт в запрос как { $and: [фильтр клиента, { $or: [фильтры права] }] },
// а хуки сужают списки через $in. Без $and/$or/$in права в demo проверялись
// бы не так, как на настоящей базе.
function matches(item, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$and") return expected.every((part) => matches(item, part))
    if (key === "$or") return expected.some((part) => matches(item, part))
    if (key === "$nor") return !expected.some((part) => matches(item, part))

    const value = getByPath(item, key)
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$eq" in expected && !equals(value, expected.$eq)) return false
      if ("$ne" in expected && equals(value, expected.$ne)) return false
      if ("$in" in expected && !expected.$in.some((entry) => equals(value, entry))) return false
      if ("$nin" in expected && expected.$nin.some((entry) => equals(value, entry))) return false
      if ("$exists" in expected && (value !== undefined) !== Boolean(expected.$exists)) return false
      if ("$gt" in expected && !(value > expected.$gt)) return false
      if ("$gte" in expected && !(value >= expected.$gte)) return false
      if ("$lt" in expected && !(value < expected.$lt)) return false
      if ("$lte" in expected && !(value <= expected.$lte)) return false
      return true
    }
    return equals(value, expected)
  })
}

// Как в Mongo: поле-массив совпадает, если совпал любой элемент.
function equals(value, expected) {
  return Array.isArray(value) && !Array.isArray(expected) ? value.includes(expected) : value === expected
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
