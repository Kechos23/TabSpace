const label =
  new URLSearchParams(location.search).get("name") === "B" ? "B" : "A";
document.title = `Drag Group test ${label}`;
document.getElementById("name").textContent = document.title;
