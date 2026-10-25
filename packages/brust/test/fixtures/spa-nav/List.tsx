import { useState } from 'react'

export default function List() {
  const [items, setItems] = useState(['a', 'b'])
  return (
    <article data-page="list">
      <title>List</title>
      <meta name="description" content="the list page" />
      <link rel="canonical" href="https://spa.example/list" />
      <link rel="stylesheet" href="/public/y.css" />
      <link rel="stylesheet" href="/public/x.css" />
      <ul id="items">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <button type="button" id="add" onClick={() => setItems([...items, `n${items.length}`])}>
        add
      </button>
    </article>
  )
}
