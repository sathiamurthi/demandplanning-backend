async function test() {
  try {
    const res = await fetch('http://localhost:4000/v1/school/generate-study-guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'English', chapterName: 'Chapter 1' })
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text);
  } catch (err) {
    console.error(err);
  }
}
test();
