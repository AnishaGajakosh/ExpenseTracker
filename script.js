const TOKEN_KEY = "expenseTrackerToken";
const USER_KEY = "expenseTrackerUser";
const VALID_SECTIONS = ["dashboard","addExpense","expenses","analytics"];
const GMAIL_REGEX = /^[^\s@]+@gmail\.com$/i;

const $ = id => document.getElementById(id);
function isValidGmail(email){ return GMAIL_REGEX.test(String(email || "").trim()); }
function escapeHtml(value){ return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function setMessage(id,text){ if($(id)) $(id).textContent=text; }
function money(value){ return `₹${Number(value || 0).toFixed(2)}`; }

async function apiFetch(url, options={}){
  const headers={...(options.headers||{})};
  const token=localStorage.getItem(TOKEN_KEY);
  if(token) headers.Authorization=`Bearer ${token}`;
  const response=await fetch(url,{...options,headers});
  if(response.status===401){
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    if(location.pathname.endsWith("dashboard.html")) location.href="login.html";
    throw new Error("Please sign in again.");
  }
  return response;
}

const signinForm=$("signinForm");
if(signinForm){
  signinForm.addEventListener("submit",async e=>{
    e.preventDefault();

    const email=$("signinEmail").value.trim().toLowerCase();
    const password=$("signinPassword").value;

    if(!isValidGmail(email)){
      setMessage("signinMessage","Invalid Gmail address.");
      return;
    }

    try{
      const response=await fetch("/api/auth/signin",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email,password})
      });

      const data=await response.json();

      if(!response.ok) throw new Error(data.message||"Could not sign in.");

      localStorage.setItem(TOKEN_KEY,data.token);
      localStorage.setItem(USER_KEY,JSON.stringify(data.user));

      location.href="dashboard.html#dashboard";

    }catch(error){
      setMessage("signinMessage",error.message);
    }
  });
}

const signupForm=$("signupForm");
if(signupForm){
  signupForm.addEventListener("submit",async e=>{
    e.preventDefault();

    const name=$("signupName").value.trim();
    const email=$("signupEmail").value.trim().toLowerCase();
    const password=$("signupPassword").value;
    const confirm=$("signupConfirmPassword").value;

    if(!isValidGmail(email)){
      setMessage("signupMessage","Invalid Gmail address.");
      return;
    }

    if(password!==confirm){
      setMessage("signupMessage","Passwords do not match.");
      return;
    }

    try{
      const response=await fetch("/api/auth/signup",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({name,email,password})
      });

      const data=await response.json();

      if(!response.ok) throw new Error(data.message||"Could not create account.");

      location.href=`login.html?email=${encodeURIComponent(email)}&created=1`;

    }catch(error){
      setMessage("signupMessage",error.message);
    }
  });
}

if($("signinEmail")&&location.search){
  const params=new URLSearchParams(location.search);
  const email=params.get("email");

  if(email) $("signinEmail").value=email;
  if(params.get("created")) setMessage("signinMessage","Account created. Please sign in.");
}

const app=$("app");

if(app){
  const logoutBtn=$("logoutBtn");

  document.querySelectorAll("[data-section]").forEach(btn=>{
    btn.addEventListener("click",()=>showSection(btn.dataset.section));
  });

  logoutBtn.addEventListener("click",async()=>{
    try{
      await apiFetch("/api/auth/logout",{method:"POST"});
    }catch(_){}

    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    location.href="login.html";
  });

  $("expenseForm").addEventListener("submit",async e=>{
    e.preventDefault();

    const expense={
      amount:$("amount").value,
      category:$("category").value,
      description:$("description").value,
      date:$("date").value
    };

    try{
      const response=await apiFetch("/api/expenses",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify(expense)
      });

      const data=await response.json();

      if(!response.ok) throw new Error(data.message||"Error adding expense");

      $("expenseForm").reset();
      setMessage("expenseMessage","Expense added successfully.");
      showSection("dashboard");

    }catch(error){
      setMessage("expenseMessage",error.message);
    }
  });

  $("searchInput").addEventListener("input",loadExpenses);
  $("categoryFilter").addEventListener("change",loadExpenses);
  $("sortSelect").addEventListener("change",loadExpenses);

  const today=new Date();
  $("todayDate").textContent=today.toLocaleDateString("en-IN",{
    day:"2-digit",
    month:"short",
    year:"numeric"
  });

  initApp();
}

function showSection(sectionId){
  if(!VALID_SECTIONS.includes(sectionId)) sectionId="dashboard";

  history.replaceState(null,"",`dashboard.html#${sectionId}`);

  document.querySelectorAll(".section").forEach(s=>s.classList.remove("active"));

  const target=$(sectionId);
  if(target) target.classList.add("active");

  document.querySelectorAll(".nav-btn").forEach(b=>{
    b.classList.toggle("active",b.dataset.section===sectionId);
  });

  const titles={
    dashboard:["Dashboard","See your expense summary at a glance."],
    addExpense:["Add Expense","Enter your expense details below."],
    expenses:["Expenses","View, search, sort and manage your expenses."],
    analytics:["Analytics","A simple summary of your spending."]
  };

  $("pageTitle").textContent=titles[sectionId][0];
  $("pageSubtitle").textContent=titles[sectionId][1];

  if(sectionId==="dashboard") loadDashboard();
  if(sectionId==="expenses") loadExpenses();
  if(sectionId==="analytics") loadAnalytics();
}

window.addEventListener("hashchange",()=>{
  if(location.pathname.endsWith("dashboard.html")){
    showSection(location.hash.slice(1)||"dashboard");
  }
});

async function loadDashboard(){
  try{
    const response=await apiFetch("/api/dashboard");
    const data=await response.json();

    $("totalExpenses").textContent=money(data.totalExpenses);
    $("expenseCount").textContent=data.expenseCount||0;
    $("highestExpense").textContent=money(data.highestExpense);

    const month=new Date();
    const monthPrefix=`${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,"0")}`;
    const recent=data.recentExpenses||[];

    const monthTotal=recent
      .filter(e=>String(e.date).startsWith(monthPrefix))
      .reduce((sum,e)=>sum+Number(e.amount||0),0);

    $("monthExpense").textContent=money(monthTotal);

    $("recentExpenseTable").innerHTML=recent.length
      ? recent.map(e=>`<tr><td>${escapeHtml(e.date)}</td><td>${escapeHtml(e.category)}</td><td>${escapeHtml(e.description)}</td><td>${money(e.amount)}</td></tr>`).join("")
      : '<tr><td colspan="4" class="empty-cell">No expenses yet. Add your first expense.</td></tr>';

  }catch(error){
    console.error(error);
  }
}

async function loadExpenses(){
  const params=new URLSearchParams();
  const search=$("searchInput").value;
  const category=$("categoryFilter").value;
  const sort=$("sortSelect").value;

  if(search) params.set("search",search);
  if(category) params.set("category",category);
  if(sort) params.set("sort",sort);

  try{
    const response=await apiFetch(`/api/expenses?${params}`);
    const expenses=await response.json();

    $("expenseTable").innerHTML="";

    if(!expenses.length){
      $("expenseTable").innerHTML='<tr><td colspan="5" class="empty-cell">No expenses found.</td></tr>';
      return;
    }

    expenses.forEach(e=>{
      const row=document.createElement("tr");

      row.innerHTML=`
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.category)}</td>
        <td>${escapeHtml(e.description)}</td>
        <td>${money(e.amount)}</td>
        <td>
          <button class="edit-btn" onclick="startEdit(this,'${e._id}')">Edit</button>
          <button class="delete-btn" onclick="deleteExpense('${e._id}')">Delete</button>
        </td>`;

      $("expenseTable").appendChild(row);
    });

  }catch(error){
    console.error(error);
  }
}

function startEdit(button,id){
  const row=button.closest("tr");
  const date=row.cells[0].innerText;
  const category=row.cells[1].innerText;
  const description=row.cells[2].innerText;
  const amount=row.cells[3].innerText.replace("₹","");

  row.innerHTML=`
    <td><input type="date" value="${date}"></td>
    <td>
      <select>
        <option ${category==="Food"?"selected":""}>Food</option>
        <option ${category==="Travel"?"selected":""}>Travel</option>
        <option ${category==="Shopping"?"selected":""}>Shopping</option>
        <option ${category==="Education"?"selected":""}>Education</option>
        <option ${category==="Bills"?"selected":""}>Bills</option>
        <option ${category==="Other"?"selected":""}>Other</option>
      </select>
    </td>
    <td><input type="text" value="${escapeHtml(description)}"></td>
    <td><input type="number" min="0.01" step="0.01" value="${amount}"></td>
    <td><button class="edit-btn" onclick="saveEdit(this,'${id}')">Save</button></td>`;
}

async function saveEdit(button,id){
  const row=button.closest("tr");

  const updatedExpense={
    date:row.cells[0].querySelector("input").value,
    category:row.cells[1].querySelector("select").value,
    description:row.cells[2].querySelector("input").value,
    amount:row.cells[3].querySelector("input").value
  };

  try{
    const response=await apiFetch(`/api/expenses/${id}`,{
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(updatedExpense)
    });

    const data=await response.json();

    if(!response.ok) throw new Error(data.message||"Update failed");

    loadExpenses();
    loadDashboard();

  }catch(error){
    alert(error.message);
  }
}

async function deleteExpense(id){
  if(!confirm("Are you sure you want to delete this expense?")) return;

  try{
    const response=await apiFetch(`/api/expenses/${id}`,{
      method:"DELETE"
    });

    const data=await response.json();

    if(!response.ok) throw new Error(data.message||"Delete failed");

    loadExpenses();
    loadDashboard();

  }catch(error){
    alert(error.message);
  }
}

async function loadAnalytics(){
  try{
    const response=await apiFetch("/api/analytics");
    const data=await response.json();

    $("analyticsTotal").textContent=money(data.totalExpense);
    $("averageExpense").textContent=money(data.averageExpense);
    $("analyticsHighest").textContent=money(data.highestExpense);

    $("categorySummary").innerHTML=data.categorySummary.length
      ? data.categorySummary.map(i=>`
          <tr>
            <td>${escapeHtml(i._id)}</td>
            <td>${money(i.totalAmount)}</td>
            <td>${i.count}</td>
          </tr>
        `).join("")
      : '<tr><td colspan="3" class="empty-cell">No expenses found.</td></tr>';

  }catch(error){
    console.error(error);
  }
}

async function initApp(){
  const token=localStorage.getItem(TOKEN_KEY);

  if(!token){
    location.href="login.html";
    return;
  }

  try{
    const response=await apiFetch("/api/auth/me");
    const data=await response.json();

    if(!response.ok) throw new Error();

    localStorage.setItem(USER_KEY,JSON.stringify(data.user));

    $("userName").textContent=data.user.name;
    $("userEmail").textContent=data.user.email;
    $("welcomeName").textContent=data.user.name;

    const section=VALID_SECTIONS.includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : "dashboard";

    showSection(section);

  }catch(_){
    location.href="login.html";
  }
}