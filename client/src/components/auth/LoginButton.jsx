export default function LoginButton() {
  const login = () => {
    window.location.href = "http://localhost:4000/api/auth/github";
  };

  return (
    <button
      onClick={login}
      className="px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800"
    >
      Login with GitHub
    </button>
  );
}
