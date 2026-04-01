const signUpButton = document.getElementById("signUp");
const signInButton = document.getElementById("signIn");
const container = document.getElementById("container");

signUpButton.addEventListener("click", () => {
    container.classList.add("right-panel-active");
});

signInButton.addEventListener("click", () => {
    container.classList.remove("right-panel-active");
});

const BASE_URL = "https://one337-chat-reborn-server.onrender.com";

const Toast = Swal.mixin({
    toast: true,
    position: "top-end",
    showConfirmButton: false,
    timer: 5000,
});
Toast.fire({
    icon: "success",
    title: "1337 Chat\n\nMade By Payson\ngithub.com/paysonism",
});

const signupForm = document.getElementById("signUpForm");
signupForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const name = signupForm.signUpName.value.trim();
    const email = signupForm.signUpEmail.value.trim();
    const password = signupForm.signUpPassword.value;
    const picture = signupForm.signUpUrl.value.trim();

    // Client-side validation
    if (name.length < 2) {
        return Toast.fire({ icon: "error", title: "Name must be at least 2 characters." });
    }
    if (password.length < 6) {
        return Toast.fire({ icon: "error", title: "Password must be at least 6 characters." });
    }

    const payload = {
        name,
        email,
        password,
        picture: picture === "" ? undefined : picture,
    };
    register(payload);
});

const register = async (payload) => {
    try {
        const res = await fetch(`${BASE_URL}/user/signup`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        let data = await res.json();
        if (data.success) {
            Toast.fire({
                icon: "success",
                title: "Successfully Registered! You can now sign in.",
            });
            signupForm.signUpName.value = "";
            signupForm.signUpEmail.value = "";
            signupForm.signUpPassword.value = "";
            signupForm.signUpUrl.value = "";
            // Switch to login panel
            container.classList.remove("right-panel-active");
        } else {
            Toast.fire({
                icon: "error",
                title: data.error,
            });
        }
    } catch (error) {
        Swal.fire({
            title: "Error!",
            text: "Could not connect to the server. Make sure it is running.",
            icon: "error",
            confirmButtonText: "Retry",
        });
    }
};

const loginForm = document.getElementById("loginForm");
loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const payload = {
        email: loginForm.loginEmail.value.trim(),
        password: loginForm.loginPassword.value,
    };
    login(payload);
});

const login = async (payload) => {
    try {
        const res = await fetch(`${BASE_URL}/user/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        let data = await res.json();
        if (data.success) {
            Toast.fire({
                icon: "success",
                title: "Successfully Logged in!",
            });
            localStorage.setItem("token", data.token);
            const user = data.userId;
            window.location.href = `dashboard.html?id=${user}`;
        } else {
            Swal.fire({
                title: "Error!",
                text: data.error,
                icon: "error",
                confirmButtonText: "Retry",
            });
        }
    } catch (error) {
        Swal.fire({
            title: "Error!",
            text: "Could not connect to the server. Make sure it is running.",
            icon: "error",
            confirmButtonText: "Retry",
        });
    }
};
